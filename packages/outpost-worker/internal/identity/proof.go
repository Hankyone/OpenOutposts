package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const proofDomain = "openoutposts-connect-v1"

func CanonicalProof(method, path, outpostID, timestamp, nonce string) string {
	return proofDomain + "\n" + method + "\n" + path + "\n" + outpostID + "\n" + timestamp + "\n" + nonce
}

func AddProof(request *http.Request, outpostID, keyFingerprint string, privateKey ed25519.PrivateKey, now time.Time) error {
	nonceBytes := make([]byte, 24)
	if _, err := rand.Read(nonceBytes); err != nil {
		return fmt.Errorf("generate connection nonce: %w", err)
	}
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	signature := ed25519.Sign(
		privateKey,
		[]byte(CanonicalProof(request.Method, request.URL.EscapedPath(), outpostID, timestamp, nonce)),
	)
	request.Header.Set("X-OpenOutposts-Timestamp", timestamp)
	request.Header.Set("X-OpenOutposts-Nonce", nonce)
	request.Header.Set("X-OpenOutposts-Signature", base64.RawURLEncoding.EncodeToString(signature))
	request.Header.Set("X-OpenOutposts-Key-Fingerprint", keyFingerprint)
	return nil
}
