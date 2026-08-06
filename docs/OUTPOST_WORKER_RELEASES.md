# Outpost worker releases and signing

Every enrolled outpost worker updates itself. This document covers the operator side: the secrets
that produce a release, where they live, and how to rotate the one that matters.

For what an installed outpost worker does with a release, see
[`packages/outpost-worker/README.md`](../packages/outpost-worker/README.md#self-update). For a local
end-to-end walkthrough, see the self-update smoke test in
[`OUTPOSTS_QUICKSTART.md`](OUTPOSTS_QUICKSTART.md).

## How a release reaches a machine

1. Tagging `outpost-worker-vX.Y.Z` runs `.github/workflows/release-outpost-worker.yml`.
2. The workflow cross-builds four platforms, pulls the channel's current manifest and blobs out of
   R2, and diffs the new binaries against the previous ones.
3. It signs the manifest with the release signing key, then re-verifies the signature and re-applies
   every patch it just wrote. A release that fails that check is never published.
4. It uploads blobs and patches **before** the manifest, so no outpost worker can read a manifest
   naming an object that is not there yet.
5. Outpost workers fetch `{control plane}/releases/outpost-worker/stable/manifest.json`, verify its
   signature against a public key compiled into their own binary, and install what it names.

## Secrets

| Name                               | Where                           | What it is                                                      |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `OPENOUTPOSTS_RELEASE_SIGNING_KEY` | GitHub secret, `release` env    | Ed25519 seed that signs release manifests                       |
| `R2_RELEASES_ACCESS_KEY_ID`        | GitHub secret, `release` env    | R2 access key for the release bucket                            |
| `R2_RELEASES_SECRET_ACCESS_KEY`    | GitHub secret, `release` env    | R2 secret for the release bucket                                |
| `CLOUDFLARE_ACCOUNT_ID`            | GitHub secret                   | Builds the R2 S3 endpoint URL                                   |
| `OPENOUTPOSTS_RELEASE_PUBLIC_KEY`  | GitHub **variable**, not secret | The public key the verify gate checks against; not confidential |

`OPENOUTPOSTS_RELEASE_SIGNING_KEY` is the highest-value secret in the deployment. Anything holding
it can sign a manifest that installs arbitrary code on every enrolled machine — more reach than the
control plane's own credentials, because it lands inside the user's operating-system account rather
than inside a sandbox. Treat it accordingly:

- Generate it with `openoutpost-release keygen`, which prints it and writes it nowhere.
- Store it only as a GitHub Actions secret scoped to a **protected `release` environment**, so
  publishing requires whatever approval that environment demands rather than repository write
  access.
- The workflow reads it from the environment and never from a command-line flag, so it cannot appear
  in a process listing or a job log.
- Keep no second copy. A lost key is recoverable through rotation; a leaked one is not.

The R2 credentials should be scoped to the release bucket alone. They write objects the whole fleet
executes, but they cannot forge a manifest — an unsigned or wrongly signed manifest is refused by
every worker.

## Setting it up the first time

```sh
cd packages/outpost-worker
go run ./cmd/openoutpost-release keygen
```

1. Store the printed seed (stdout) as `OPENOUTPOSTS_RELEASE_SIGNING_KEY` in the repository's
   protected `release` environment.
2. Store the printed public key (stderr) as the `OPENOUTPOSTS_RELEASE_PUBLIC_KEY` repository
   variable, and paste the same value into `releasePublicKeysBase64` in
   `packages/outpost-worker/internal/update/keys.go`.
3. `terraform apply` to create the release bucket and bind it to the control plane, then create the
   R2 API token for that bucket and store its two halves as secrets.
4. Tag `outpost-worker-v0.1.0`. That first release bootstraps the channel: full binaries, no
   patches.

Until step 2 lands in a shipped binary, workers log
`self-update disabled: no release public key embedded` and never update. That is the intended
fail-closed default, not a misconfiguration to work around.

## Rotating the signing key

The order matters. Skipping the first step strands every worker that has not yet updated — it would
have no key that verifies the new manifest, and would stop updating silently.

1. Generate the new key. Add its public key to `releasePublicKeysBase64` **alongside** the existing
   one and ship a release still signed with the **old** key.
2. Wait until the fleet has picked that build up (the machines page shows each machine's
   `workerVersion`).
3. Replace `OPENOUTPOSTS_RELEASE_SIGNING_KEY` and `OPENOUTPOSTS_RELEASE_PUBLIC_KEY` with the new
   key's values. Releases from here are signed with the new key and verified by every worker.
4. In a later release, drop the old public key from `keys.go`.

If the old key is believed compromised, steps 1 to 3 still have to happen in order — but shorten the
wait and accept that machines which have not updated will need a manual reinstall, rather than
leaving a compromised key able to sign for them.
