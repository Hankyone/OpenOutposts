package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/config"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/controlplane"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/enroll"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/identity"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/protocol"
	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/update"
)

var version = "dev"

// selfUpdateEnvName turns the background updater off without a flag, for
// supervisors that own the command line.
const selfUpdateEnvName = "OPENOUTPOSTS_SELF_UPDATE"

// updateBaseURLEnvName overrides where release objects are fetched from. It
// exists for the local smoke test in the quickstart; deployments serve them
// from their own control plane.
const updateBaseURLEnvName = "OPENOUTPOSTS_UPDATE_BASE_URL"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "enroll":
			runEnroll(os.Args[2:])
			return
		case "update":
			runUpdate(os.Args[2:])
			return
		}
	}

	showVersion := flag.Bool("version", false, "print the worker version")
	noSelfUpdate := flag.Bool("no-self-update", false, "do not check for or install worker updates")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	cfg := config.FromEnvironment()
	if err := cfg.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(2)
	}

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	// Before anything connects: a binary installed by the previous run that
	// has never managed to register gets a bounded number of tries before the
	// one it replaced is put back.
	if stateDir, err := identity.DefaultStateDir(); err != nil {
		logger.Warn("could not resolve the state directory for the update guard", "error", err)
	} else if err := update.RunStartupGuard(logger, stateDir, version, update.ExecSelf); err != nil {
		logger.Warn("update startup guard failed", "error", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger.Info("starting outpost worker", "version", version, "outpost_id", cfg.ID, "name", cfg.Name, "platform", cfg.Platform, "architecture", cfg.Architecture, "protocol_version", protocol.Version)
	client := controlplane.New(cfg, version, logger)
	startSelfUpdater(ctx, logger, cfg, client, *noSelfUpdate)
	if err := client.Run(ctx); err != nil && err != context.Canceled {
		logger.Error("outpost worker stopped", "error", err)
		os.Exit(1)
	}
}

// startSelfUpdater brings up the background updater. Every reason it cannot
// run is a log line and nothing more: a worker that cannot update itself is
// still a worker.
func startSelfUpdater(
	ctx context.Context,
	logger *slog.Logger,
	cfg config.Config,
	client *controlplane.Client,
	disabled bool,
) {
	if disabled || strings.EqualFold(os.Getenv(selfUpdateEnvName), "off") {
		logger.Info("self-update disabled by configuration")
		return
	}
	stateDir, err := identity.DefaultStateDir()
	if err != nil {
		logger.Warn("self-update unavailable", "error", err)
		return
	}
	baseURL := update.BaseURL(cfg.ControlPlaneURL)
	if configured := os.Getenv(updateBaseURLEnvName); configured != "" {
		baseURL = strings.TrimRight(configured, "/") + "/"
	}
	updater, err := update.New(update.Options{
		StateDir:       stateDir,
		BaseURL:        baseURL,
		Channel:        update.DefaultChannel,
		CurrentVersion: version,
		Idle:           client.Idle,
		ExecSelf:       update.ExecSelf,
		Log:            logger,
		Keys:           update.ReleasePublicKeys(),
	})
	if err != nil {
		switch {
		case errors.Is(err, update.ErrDevBuild):
			logger.Info("self-update disabled for development builds")
		case errors.Is(err, update.ErrNoReleaseKeys):
			logger.Info("self-update disabled: no release public key embedded")
		default:
			logger.Warn("self-update unavailable", "error", err)
		}
		return
	}
	client.OnRegistered(updater.ConfirmIfPending)
	go updater.Run(ctx)
}

type stringList []string

func (values *stringList) String() string {
	return strings.Join(*values, ",")
}

func (values *stringList) Set(value string) error {
	if value == "" {
		return fmt.Errorf("workspace root cannot be empty")
	}
	*values = append(*values, value)
	return nil
}

func runEnroll(arguments []string) {
	flags := flag.NewFlagSet("enroll", flag.ContinueOnError)
	controlPlaneURL := flags.String("control-plane", "", "control plane URL")
	token := flags.String("token", "", "one-time enrollment token")
	name := flags.String("name", "", "machine display name")
	stateDir := flags.String("state-dir", "", "identity storage directory")
	var workspaceRoots stringList
	flags.Var(&workspaceRoots, "workspace-root", "workspace directory the agent may access")
	if err := flags.Parse(arguments); err != nil {
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := enroll.Run(ctx, enroll.Options{
		ControlPlaneURL: *controlPlaneURL,
		Token:           *token,
		Name:            *name,
		WorkspaceRoots:  workspaceRoots,
		StateDir:        *stateDir,
		WorkerVersion:   version,
		Output:          os.Stdout,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "enrollment error: %v\n", err)
		os.Exit(1)
	}
}

// runUpdate is the manual form of what the daemon does on its own schedule.
// It takes the same lock, so it cannot race a background update, and it skips
// the idle gate: an operator running it has decided the timing.
func runUpdate(arguments []string) {
	flags := flag.NewFlagSet("update", flag.ContinueOnError)
	check := flags.Bool("check", false, "report whether a newer version is available and exit")
	channel := flags.String("channel", update.DefaultChannel, "release channel")
	stateDir := flags.String("state-dir", "", "identity storage directory")
	if err := flags.Parse(arguments); err != nil {
		os.Exit(2)
	}

	resolvedStateDir := *stateDir
	if resolvedStateDir == "" {
		resolved, err := identity.DefaultStateDir()
		if err != nil {
			fmt.Fprintf(os.Stderr, "update error: %v\n", err)
			os.Exit(1)
		}
		resolvedStateDir = resolved
	}

	baseURL := ""
	if configured := os.Getenv(updateBaseURLEnvName); configured != "" {
		baseURL = strings.TrimRight(configured, "/") + "/"
	} else if machineIdentity, err := identity.Load(resolvedStateDir); err == nil {
		controlPlaneURL := machineIdentity.ControlPlaneURL
		if configured := os.Getenv("OPENOUTPOSTS_CONTROL_PLANE_URL"); configured != "" {
			controlPlaneURL = configured
		}
		baseURL = update.BaseURL(controlPlaneURL)
	} else if configured := os.Getenv("OPENOUTPOSTS_CONTROL_PLANE_URL"); configured != "" {
		baseURL = update.BaseURL(configured)
	} else {
		fmt.Fprintln(os.Stderr, "update error: this machine has no identity; run 'openoutpost enroll' first")
		os.Exit(1)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	updater, err := update.New(update.Options{
		StateDir:       resolvedStateDir,
		BaseURL:        baseURL,
		Channel:        *channel,
		CurrentVersion: version,
		// No idle gate: this is a foreground command an operator asked for.
		Idle: nil,
		// Nothing to re-exec into. The command installs the binary and exits;
		// a running daemon picks it up when it next restarts.
		ExecSelf: func(string) error { return nil },
		Log:      logger,
		Keys:     update.ReleasePublicKeys(),
	})
	if err != nil {
		switch {
		case errors.Is(err, update.ErrDevBuild):
			fmt.Fprintln(os.Stderr, "update error: this is a development build and has no release to compare against")
		case errors.Is(err, update.ErrNoReleaseKeys):
			fmt.Fprintln(os.Stderr, "update error: this build has no embedded release public key")
		default:
			fmt.Fprintf(os.Stderr, "update error: %v\n", err)
		}
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *check {
		plan, err := updater.Check(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "update error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("current: %s\nlatest:  %s\n", version, plan.TargetVersion)
		if plan.Kind == update.UpToDate {
			fmt.Println("This worker is up to date.")
			return
		}
		fmt.Println("A newer worker is available. Run 'openoutpost update' to install it.")
		os.Exit(1)
	}

	if err := updater.CheckOnce(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "update error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("The installed binary is current. A running worker picks it up when it restarts.")
}
