package enroll

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/identity"
)

func TestRunConsumesTokenStoresIdentityAndWaitsForConfirmation(t *testing.T) {
	var sawConsume bool
	var sawStatus bool
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/outposts/enrollments/consume":
			sawConsume = true
			if request.Header.Get("Authorization") != "Bearer oo_enroll_test" {
				t.Errorf("authorization = %q", request.Header.Get("Authorization"))
			}
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["publicKey"] == "" {
				t.Error("public key missing")
			}
			response.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(response).Encode(map[string]string{
				"enrollmentId":     "enroll-test",
				"outpostId":        "outpost-test",
				"confirmationCode": "123-456",
				"expiresAt":        "2099-01-01T00:00:00Z",
			})
		case "/outposts/outpost-test/enrollment-status":
			sawStatus = true
			for _, header := range []string{
				"X-OpenOutposts-Timestamp",
				"X-OpenOutposts-Nonce",
				"X-OpenOutposts-Signature",
				"X-OpenOutposts-Key-Fingerprint",
			} {
				if request.Header.Get(header) == "" {
					t.Errorf("%s missing", header)
				}
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"state":     "confirmed",
				"confirmed": true,
				"revoked":   false,
			})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	stateDir := t.TempDir()
	var output bytes.Buffer
	err := Run(context.Background(), Options{
		ControlPlaneURL: server.URL,
		Token:           "oo_enroll_test",
		Name:            "studio",
		WorkspaceRoots:  []string{"/workspace"},
		StateDir:        stateDir,
		WorkerVersion:   "test",
		Output:          &output,
		HTTPClient:      server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !sawConsume || !sawStatus {
		t.Fatalf("consume=%v status=%v", sawConsume, sawStatus)
	}
	if !strings.Contains(output.String(), "123-456") || !strings.Contains(output.String(), "confirmed") {
		t.Fatalf("unexpected output: %s", output.String())
	}
	stored, err := identity.Load(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if stored.OutpostID != "outpost-test" {
		t.Fatalf("outpost id = %q", stored.OutpostID)
	}
	content, err := os.ReadFile(identity.Path(stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "oo_enroll_test") {
		t.Fatal("one-time enrollment token was stored in identity")
	}
}
