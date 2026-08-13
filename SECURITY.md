# Security Policy

## Technical Preview

The current packages are unsigned technical-preview builds. Do not use them for
unattended production deployment or real outbound campaigns until the release
is signed and all external acceptance gates have passed.

## Reporting A Vulnerability

Use the repository's private vulnerability reporting or Security Advisory
feature. Do not publish a security vulnerability as a public GitHub Issue.

Never include passwords, API keys, access tokens, private keys, mailbox app
passwords, SSH credentials, customer data, or complete `.env` files in a report.
If a credential is exposed, revoke or rotate it before continuing testing.

## Installer Safety Defaults

- Secrets are stored locally with Windows DPAPI.
- SSH host fingerprints require operator confirmation.
- External outbound activity is paused after installation.
- Human-required steps enter a resumable `BLOCKED` state.
- Deployment releases support rollback to the prior checkpoint.
