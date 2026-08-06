package enroll

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/identity"
)

const pollInterval = time.Second

type Options struct {
	ControlPlaneURL string
	Token           string
	Name            string
	WorkspaceRoots  []string
	StateDir        string
	WorkerVersion   string
	Output          io.Writer
	HTTPClient      *http.Client
}

type consumeResponse struct {
	EnrollmentID     string `json:"enrollmentId"`
	OutpostID        string `json:"outpostId"`
	ConfirmationCode string `json:"confirmationCode"`
	ExpiresAt        string `json:"expiresAt"`
}

type statusResponse struct {
	State     string `json:"state"`
	Confirmed bool   `json:"confirmed"`
	Revoked   bool   `json:"revoked"`
}

func Run(ctx context.Context, options Options) error {
	if options.Output == nil {
		options.Output = os.Stdout
	}
	if options.HTTPClient == nil {
		options.HTTPClient = http.DefaultClient
	}
	if options.Name == "" {
		options.Name, _ = os.Hostname()
	}
	if options.WorkerVersion == "" {
		options.WorkerVersion = "dev"
	}
	if options.StateDir == "" {
		stateDir, err := identity.DefaultStateDir()
		if err != nil {
			return fmt.Errorf("resolve identity directory: %w", err)
		}
		options.StateDir = stateDir
	}
	if err := validateOptions(options); err != nil {
		return err
	}

	machineIdentity, err := identity.Generate(
		strings.TrimRight(options.ControlPlaneURL, "/"),
		options.Name,
		options.WorkspaceRoots,
	)
	if err != nil {
		return err
	}
	consumed, err := consume(ctx, options, machineIdentity)
	if err != nil {
		return err
	}
	machineIdentity.OutpostID = consumed.OutpostID
	if err := identity.Save(options.StateDir, machineIdentity); err != nil {
		return err
	}

	fmt.Fprintf(options.Output, "Confirmation code: %s\n", consumed.ConfirmationCode)
	fmt.Fprintln(options.Output, "Confirm this code on the Machines page.")

	expiresAt, err := time.Parse(time.RFC3339, consumed.ExpiresAt)
	if err != nil {
		return errors.New("control plane returned an invalid enrollment expiry")
	}
	privateKey, err := machineIdentity.PrivateKey()
	if err != nil {
		return err
	}
	for {
		if !time.Now().Before(expiresAt) {
			return errors.New("enrollment expired before it was confirmed")
		}
		status, err := enrollmentStatus(
			ctx,
			options.HTTPClient,
			machineIdentity,
			privateKey,
		)
		if err != nil {
			return err
		}
		if status.Revoked {
			return errors.New("machine was revoked during enrollment")
		}
		if status.Confirmed {
			fmt.Fprintln(options.Output, "Machine confirmed. Starting the worker.")
			return nil
		}
		timer := time.NewTimer(pollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func validateOptions(options Options) error {
	if options.Token == "" {
		return errors.New("enrollment token is required")
	}
	parsed, err := url.Parse(options.ControlPlaneURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("control plane must be an http(s) URL")
	}
	if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return errors.New("control plane must use https except on loopback")
	}
	if len(options.WorkspaceRoots) == 0 {
		return errors.New("at least one workspace root is required")
	}
	for _, root := range options.WorkspaceRoots {
		if !strings.HasPrefix(root, "/") && runtime.GOOS != "windows" {
			return fmt.Errorf("workspace root %q must be absolute", root)
		}
	}
	return nil
}

func consume(ctx context.Context, options Options, machineIdentity identity.File) (consumeResponse, error) {
	body, err := json.Marshal(map[string]any{
		"name":           options.Name,
		"workerVersion":  options.WorkerVersion,
		"platform":       runtime.GOOS,
		"architecture":   runtime.GOARCH,
		"publicKey":      machineIdentity.PublicKey,
		"workspaceRoots": options.WorkspaceRoots,
	})
	if err != nil {
		return consumeResponse{}, err
	}
	endpoint := strings.TrimRight(options.ControlPlaneURL, "/") + "/outposts/enrollments/consume"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return consumeResponse{}, err
	}
	request.Header.Set("Authorization", "Bearer "+options.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := options.HTTPClient.Do(request)
	if err != nil {
		return consumeResponse{}, fmt.Errorf("consume enrollment: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return consumeResponse{}, responseError("consume enrollment", response)
	}
	var consumed consumeResponse
	if err := json.NewDecoder(response.Body).Decode(&consumed); err != nil {
		return consumeResponse{}, fmt.Errorf("decode enrollment response: %w", err)
	}
	if consumed.EnrollmentID == "" || consumed.OutpostID == "" ||
		consumed.ConfirmationCode == "" || consumed.ExpiresAt == "" {
		return consumeResponse{}, errors.New("control plane returned an incomplete enrollment")
	}
	return consumed, nil
}

func enrollmentStatus(
	ctx context.Context,
	client *http.Client,
	machineIdentity identity.File,
	privateKey ed25519.PrivateKey,
) (statusResponse, error) {
	endpoint := strings.TrimRight(machineIdentity.ControlPlaneURL, "/") +
		"/outposts/" + url.PathEscape(machineIdentity.OutpostID) + "/enrollment-status"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return statusResponse{}, err
	}
	if err := identity.AddProof(
		request,
		machineIdentity.OutpostID,
		machineIdentity.KeyFingerprint,
		privateKey,
		time.Now(),
	); err != nil {
		return statusResponse{}, err
	}
	response, err := client.Do(request)
	if err != nil {
		return statusResponse{}, fmt.Errorf("check enrollment status: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return statusResponse{}, responseError("check enrollment status", response)
	}
	var status statusResponse
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		return statusResponse{}, fmt.Errorf("decode enrollment status: %w", err)
	}
	return status, nil
}

func responseError(action string, response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = response.Status
	}
	return fmt.Errorf("%s: HTTP %d: %s", action, response.StatusCode, message)
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
