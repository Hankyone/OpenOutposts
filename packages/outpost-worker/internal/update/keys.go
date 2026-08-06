package update

import "crypto/ed25519"

// releasePublicKeysBase64 holds the Ed25519 public keys allowed to sign a
// release manifest for this build. It is deliberately empty until a release
// key exists: a worker with no embedded key fails closed and never installs
// anything, which is the only safe default for code that replaces its own
// binary.
//
// Generate a key with `openoutpost-release keygen`, keep the seed offline (the
// deployment's secret store), and paste the printed public key here.
//
// Rotation, in order, so no installed worker is ever unable to verify:
//  1. Ship a release whose keys.go lists the old key and the new one, still
//     signed with the old key.
//  2. Wait until the fleet has picked that build up.
//  3. Start signing with the new key only.
//  4. In a later release, drop the old key from this list.
//
// Skipping step 1 strands every worker that has not yet updated: it would have
// no key that verifies the new manifest and would stop updating silently.
var releasePublicKeysBase64 = []string{}

// ReleasePublicKeys returns the embedded release keys. Malformed entries are
// dropped rather than panicking in a running worker; keys_test.go fails the
// build when an entry does not decode, which is where a typo belongs.
func ReleasePublicKeys() []ed25519.PublicKey {
	keys := make([]ed25519.PublicKey, 0, len(releasePublicKeysBase64))
	for _, encoded := range releasePublicKeysBase64 {
		key, err := DecodePublicKey(encoded)
		if err != nil {
			continue
		}
		keys = append(keys, key)
	}
	return keys
}
