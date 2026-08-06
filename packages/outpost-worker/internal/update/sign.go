package update

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// Sign produces the detached signature the worker verifies. The signature
// covers the manifest's exact bytes, so re-encoding a manifest invalidates it —
// which is the point: the worker verifies what it received, not what it parsed.
func Sign(manifestBytes []byte, privateKey ed25519.PrivateKey) ([]byte, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("release signing key is not an Ed25519 private key")
	}
	return ed25519.Sign(privateKey, manifestBytes), nil
}

// EncodeSignature renders a signature for the .sig file that sits beside the
// manifest. The encoding matches the identity file's convention.
func EncodeSignature(signature []byte) string {
	return base64.RawURLEncoding.EncodeToString(signature)
}

// DecodeSignature reads a .sig file's contents. Every common base64 alphabet
// is accepted because a release engineer's tooling may differ from ours; the
// signature check itself is what establishes trust.
func DecodeSignature(encoded []byte) ([]byte, error) {
	signature, err := decodeBase64(strings.TrimSpace(string(encoded)))
	if err != nil {
		return nil, fmt.Errorf("decode release signature: %w", err)
	}
	if len(signature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("release signature is %d bytes; expected %d", len(signature), ed25519.SignatureSize)
	}
	return signature, nil
}

// EncodeSeed renders a 32-byte Ed25519 seed, matching identity.go's encoding.
func EncodeSeed(seed []byte) string {
	return base64.RawURLEncoding.EncodeToString(seed)
}

// DecodeSeed expands a stored seed back into a signing key.
func DecodeSeed(encoded string) (ed25519.PrivateKey, error) {
	seed, err := decodeBase64(strings.TrimSpace(encoded))
	if err != nil {
		return nil, fmt.Errorf("decode release signing key: %w", err)
	}
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("release signing key is %d bytes; expected a %d-byte seed", len(seed), ed25519.SeedSize)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// EncodePublicKey renders a public key for keys.go.
func EncodePublicKey(publicKey ed25519.PublicKey) string {
	return base64.RawURLEncoding.EncodeToString(publicKey)
}

// DecodePublicKey parses a release public key.
func DecodePublicKey(encoded string) (ed25519.PublicKey, error) {
	key, err := decodeBase64(strings.TrimSpace(encoded))
	if err != nil {
		return nil, fmt.Errorf("decode release public key: %w", err)
	}
	if len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("release public key is %d bytes; expected %d", len(key), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(key), nil
}

func decodeBase64(value string) ([]byte, error) {
	encodings := []*base64.Encoding{
		base64.RawURLEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.StdEncoding,
	}
	for _, encoding := range encodings {
		if decoded, err := encoding.DecodeString(value); err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("value is not valid base64")
}
