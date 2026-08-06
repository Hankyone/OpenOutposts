package update

import (
	"strings"
	"testing"
	"time"
)

// digest builds a distinguishable but well-formed sha256 for planning tests,
// where only identity matters, not the bytes behind it.
func digest(label string) string {
	return strings.Repeat("0", 64-len(label)) + label
}

func planManifest(patches []PatchEntry, latestSize int64) Manifest {
	return Manifest{
		SchemaVersion: SchemaVersion,
		Channel:       "stable",
		GeneratedAt:   time.Now().UTC(),
		Latest: Latest{
			Version: "v1.4.0",
			Platforms: map[string]PlatformArtifact{
				"linux-amd64": {
					URL:    "outpost-worker/blobs/v1.4.0/openoutpost-linux-amd64",
					SHA256: digest("140"),
					Size:   latestSize,
				},
			},
		},
		Patches: patches,
	}
}

func hop(fromVersion, from, toVersion, to string, size int64) PatchEntry {
	return PatchEntry{
		Platform:    "linux-amd64",
		FromVersion: fromVersion,
		FromSHA256:  from,
		ToVersion:   toVersion,
		ToSHA256:    to,
		URL:         "outpost-worker/patches/" + fromVersion + "_" + toVersion + "/openoutpost-linux-amd64",
		PatchSHA256: digest("p" + fromVersion),
		PatchSize:   size,
	}
}

func TestPlanUpdate(t *testing.T) {
	t.Parallel()

	singleHop := []PatchEntry{hop("v1.3.0", digest("130"), "v1.4.0", digest("140"), 100)}
	threeHops := []PatchEntry{
		hop("v1.1.0", digest("110"), "v1.2.0", digest("120"), 100),
		hop("v1.2.0", digest("120"), "v1.3.0", digest("130"), 100),
		hop("v1.3.0", digest("130"), "v1.4.0", digest("140"), 100),
	}
	brokenChain := []PatchEntry{
		hop("v1.1.0", digest("110"), "v1.2.0", digest("120"), 100),
		// The hop out of v1.2.0 is missing, so nothing reaches the target.
		hop("v1.3.0", digest("130"), "v1.4.0", digest("140"), 100),
	}

	tests := []struct {
		name          string
		patches       []PatchEntry
		latestSize    int64
		currentSHA256 string
		wantKind      PlanKind
		wantHops      int
	}{
		{
			name:          "already the latest build",
			patches:       singleHop,
			latestSize:    10_000,
			currentSHA256: digest("140"),
			wantKind:      UpToDate,
		},
		{
			name:          "one hop",
			patches:       singleHop,
			latestSize:    10_000,
			currentSHA256: digest("130"),
			wantKind:      Chain,
			wantHops:      1,
		},
		{
			name:          "three hops discovered by digest",
			patches:       threeHops,
			latestSize:    10_000,
			currentSHA256: digest("110"),
			wantKind:      Chain,
			wantHops:      3,
		},
		{
			name:          "broken chain falls back to the full download",
			patches:       brokenChain,
			latestSize:    10_000,
			currentSHA256: digest("110"),
			wantKind:      Full,
		},
		{
			name:          "patches that weigh as much as the binary are not worth it",
			patches:       threeHops,
			latestSize:    300,
			currentSHA256: digest("110"),
			wantKind:      Full,
		},
		{
			name:          "an unrecognised binary takes the full download",
			patches:       threeHops,
			latestSize:    10_000,
			currentSHA256: digest("999"),
			wantKind:      Full,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			plan, err := PlanUpdate(planManifest(test.patches, test.latestSize), "linux-amd64", test.currentSHA256)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Kind != test.wantKind {
				t.Fatalf("plan kind = %s, want %s", plan.Kind, test.wantKind)
			}
			if len(plan.Chain) != test.wantHops {
				t.Fatalf("chain has %d hops, want %d", len(plan.Chain), test.wantHops)
			}
			if plan.TargetVersion != "v1.4.0" {
				t.Fatalf("target version = %s", plan.TargetVersion)
			}
		})
	}
}

func TestPlanUpdateRejectsUnknownPlatform(t *testing.T) {
	t.Parallel()

	_, err := PlanUpdate(planManifest(nil, 10_000), "plan9-386", digest("110"))
	if err == nil {
		t.Fatal("expected a platform without an artifact to be an error")
	}
}

// A chain longer than the hop limit is not walked; the binary is fetched whole.
func TestPlanUpdateRefusesOverlongChains(t *testing.T) {
	t.Parallel()

	patches := make([]PatchEntry, 0, MaxChainHops+1)
	from := digest("000")
	for index := 0; index < MaxChainHops+1; index++ {
		to := digest(string(rune('a' + index)))
		if index == MaxChainHops {
			to = digest("140")
		}
		patches = append(patches, hop("v1.0."+string(rune('0'+index)), from, "v1.0."+string(rune('1'+index)), to, 10))
		from = to
	}

	plan, err := PlanUpdate(planManifest(patches, 10_000), "linux-amd64", digest("000"))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Kind != Full {
		t.Fatalf("plan kind = %s, want %s", plan.Kind, Full)
	}
}
