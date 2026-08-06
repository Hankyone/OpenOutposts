package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"flag"
	"fmt"
	"os"

	"github.com/Hankyone/OpenOutposts/packages/outpost-worker/internal/update"
)

// runKeygen prints a fresh release key pair. It deliberately writes nothing to
// disk: the seed is the one secret that can install code on every enrolled
// machine, and the only place it belongs is the deployment's secret store.
func runKeygen(arguments []string) error {
	flags := flag.NewFlagSet("keygen", flag.ContinueOnError)
	if err := flags.Parse(arguments); err != nil {
		return err
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("generate release signing key: %w", err)
	}

	fmt.Fprintln(os.Stdout, update.EncodeSeed(privateKey.Seed()))
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Above (stdout) is the release signing key. Store it as the")
	fmt.Fprintln(os.Stderr, "OPENOUTPOSTS_RELEASE_SIGNING_KEY secret and keep no other copy.")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Add this line to internal/update/keys.go, keeping any key already")
	fmt.Fprintln(os.Stderr, "listed until the fleet has picked the new build up:")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintf(os.Stderr, "\t\"%s\",\n", update.EncodePublicKey(publicKey))
	fmt.Fprintln(os.Stderr, "")
	return nil
}
