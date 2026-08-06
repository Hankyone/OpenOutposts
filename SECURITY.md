# Security Policy

## Supported versions

OpenOutposts is under active development before its first stable release. Security fixes are made on
the latest `main` snapshot; older snapshots are not supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for the public OpenOutposts repository. Do not
open a public issue, discussion, or pull request for a suspected vulnerability.

Include the affected component, impact, reproduction steps, and any suggested mitigation. Reports
that involve credentials should contain redacted examples only. Never send API keys, access tokens,
private keys, Terraform state, or customer data.

The maintainers will acknowledge a report as soon as practical, validate it privately, and
coordinate disclosure after a fix is available.

## Deployment credentials

OpenOutposts source code does not include hosted-service credentials or production deployment state.
Self-hosters are responsible for restricting their Cloudflare, source-control, model-provider, and
machine credentials according to their own threat model.
