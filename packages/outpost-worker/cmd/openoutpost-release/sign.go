package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/update"
)

// signingKeyEnvName is where CI holds the release signing key. It is read from
// the environment and never from a flag, so the key cannot land in a process
// listing or a shell history.
const signingKeyEnvName = "OPENOUTPOSTS_RELEASE_SIGNING_KEY"

func runSign(arguments []string) error {
	flags := flag.NewFlagSet("sign", flag.ContinueOnError)
	keyEnv := flags.String("key-env", signingKeyEnvName, "environment variable holding the release signing key")
	manifestPath := flags.String("manifest", "", "path to the manifest.json to sign")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if *manifestPath == "" {
		return errors.New("sign requires --manifest")
	}

	encodedKey := os.Getenv(*keyEnv)
	if encodedKey == "" {
		return fmt.Errorf("%s is not set", *keyEnv)
	}
	privateKey, err := update.DecodeSeed(encodedKey)
	if err != nil {
		return err
	}

	manifestBytes, err := os.ReadFile(*manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	signature, err := update.Sign(manifestBytes, privateKey)
	if err != nil {
		return err
	}
	signaturePath := *manifestPath + ".sig"
	if err := os.WriteFile(signaturePath, []byte(update.EncodeSignature(signature)+"\n"), 0o644); err != nil {
		return fmt.Errorf("write signature: %w", err)
	}
	fmt.Fprintf(os.Stderr, "signed %s -> %s\n", *manifestPath, signaturePath)
	return nil
}
