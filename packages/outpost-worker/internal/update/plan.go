package update

import "fmt"

// PlanKind is what the updater decided to do about this manifest.
type PlanKind int

const (
	// UpToDate means the running binary already is the latest build.
	UpToDate PlanKind = iota
	// Chain means a sequence of binary patches reaches the latest build.
	Chain
	// Full means download the whole binary.
	Full
)

func (k PlanKind) String() string {
	switch k {
	case UpToDate:
		return "up-to-date"
	case Chain:
		return "patch-chain"
	case Full:
		return "full-download"
	default:
		return "unknown"
	}
}

// Plan is the work needed to reach the manifest's latest build from whatever
// this machine is running.
type Plan struct {
	Kind          PlanKind
	Chain         []PatchEntry
	Full          PlatformArtifact
	TargetVersion string
}

// PlanUpdate picks the cheapest verifiable route from currentSHA256 to the
// latest build for this platform.
//
// Discovery keys on digests rather than version strings. The worker knows what
// it is running by hashing its own executable; a version string could be
// stamped wrong, replayed, or simply absent on a locally built binary, and a
// patch applied to the wrong base produces garbage that then has to be caught
// after the fact.
func PlanUpdate(manifest Manifest, platform, currentSHA256 string) (Plan, error) {
	artifact, ok := manifest.Latest.Platforms[platform]
	if !ok {
		return Plan{}, fmt.Errorf("release %s has no artifact for %s", manifest.Latest.Version, platform)
	}
	plan := Plan{TargetVersion: manifest.Latest.Version, Full: artifact}
	if currentSHA256 == artifact.SHA256 {
		plan.Kind = UpToDate
		return plan, nil
	}

	chain := shortestChain(manifest.Patches, platform, currentSHA256, artifact.SHA256)
	if len(chain) == 0 || len(chain) > MaxChainHops {
		plan.Kind = Full
		return plan, nil
	}
	var patchBytes int64
	for _, hop := range chain {
		patchBytes += hop.PatchSize
	}
	// Patching costs a download per hop plus two full-file reads and writes
	// each. Once the patches together weigh as much as the binary, the plain
	// download is both cheaper and simpler to verify.
	if patchBytes >= artifact.Size {
		plan.Kind = Full
		return plan, nil
	}
	plan.Kind = Chain
	plan.Chain = chain
	return plan, nil
}

// shortestChain walks patch entries breadth-first from the running digest to
// the target digest. Breadth-first because the manifest may offer both a long
// history of single hops and a shortcut, and because a cycle in a malformed
// manifest must not be able to loop the worker forever.
func shortestChain(patches []PatchEntry, platform, fromSHA256, toSHA256 string) []PatchEntry {
	if fromSHA256 == "" || fromSHA256 == toSHA256 {
		return nil
	}
	byFrom := make(map[string][]PatchEntry)
	for _, patch := range patches {
		if patch.Platform != platform {
			continue
		}
		byFrom[patch.FromSHA256] = append(byFrom[patch.FromSHA256], patch)
	}

	type step struct {
		digest string
		hops   []PatchEntry
	}
	visited := map[string]bool{fromSHA256: true}
	queue := []step{{digest: fromSHA256}}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if len(current.hops) >= MaxChainHops {
			continue
		}
		for _, patch := range byFrom[current.digest] {
			if visited[patch.ToSHA256] {
				continue
			}
			hops := make([]PatchEntry, len(current.hops), len(current.hops)+1)
			copy(hops, current.hops)
			hops = append(hops, patch)
			if patch.ToSHA256 == toSHA256 {
				return hops
			}
			visited[patch.ToSHA256] = true
			queue = append(queue, step{digest: patch.ToSHA256, hops: hops})
		}
	}
	return nil
}
