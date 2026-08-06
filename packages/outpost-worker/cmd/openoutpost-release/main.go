// Command openoutpost-release builds, signs and checks the release manifest
// the outpost worker updates itself from.
//
// It is an operator and CI tool, not part of the worker. The four subcommands
// are the whole release path:
//
//	keygen    mint a release signing key (offline, printed, never written)
//	generate  hash new binaries, diff them against the previous release, and
//	          write the bucket layout for a channel
//	sign      sign a manifest with the key held in a CI secret
//	verify    re-check a signed manifest and apply every patch it offers,
//	          which is the gate a release must pass before it is published
package main

import (
	"fmt"
	"os"
)

const usage = `openoutpost-release <command> [flags]

Commands:
  keygen     print a new release signing key and the public key to embed
  generate   build a release channel's blobs, patches and manifest
  sign       sign a manifest with the release signing key
  verify     verify a signed manifest and apply every patch it offers
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "keygen":
		err = runKeygen(os.Args[2:])
	case "generate":
		err = runGenerate(os.Args[2:])
	case "sign":
		err = runSign(os.Args[2:])
	case "verify":
		err = runVerify(os.Args[2:])
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}
