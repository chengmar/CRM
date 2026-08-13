# CRM Agent Customer Installer Architecture

## Product Boundary

The customer installer turns the existing operator deployment bundle into a resumable Windows application. It does not bypass third-party account ownership, reviews, CAPTCHAs, DNS control, or platform approval. Those actions become explicit manual gates.

Supported operator systems:

- Windows 10 22H2 x64
- Windows 11 x64 and arm64
- Windows Server 2019 / 2022 / 2025 x64 with Desktop Experience

Supported production target:

- Ubuntu 22.04 or 24.04 VPS
- Root SSH or a user with passwordless `sudo`

Windows 7/8 and 32-bit Windows are intentionally unsupported because current Electron, TLS, Node.js, OpenSSH, and security updates are not reliable there.

## Installation State Model

Every installation has a stable `installation_id`. Non-secret state is written atomically to the Electron user-data directory. Secrets are stored separately with Electron `safeStorage`, which uses Windows DPAPI.

Top-level states:

- `DRAFT`: configuration can still be edited.
- `RUNNING`: one automatic step is executing.
- `BLOCKED`: a human or external platform must complete an action.
- `FAILED`: the current step failed and may be retried or rolled back.
- `ROLLING_BACK`: reversible completed steps are being undone in reverse order.
- `COMPLETED`: all acceptance checks passed.

Closing the application, rebooting Windows, losing the network, or reopening a newer installer build must not reset completed steps.

## Step Contract

| Step | Mode | Resume evidence | Rollback boundary |
| --- | --- | --- | --- |
| Collect configuration | Manual | Required fields and encrypted secret flags pass validation | Restore previous saved draft |
| Check Windows | Automatic | Supported version, architecture, disk, PowerShell, network | None |
| Confirm Feishu application | Manual + API check | App credentials obtain a tenant token; required setup checklist confirmed | Remove only installer-stored credentials |
| Confirm email | Manual + protocol check | SMTP and IMAP authenticate without sending mail | Remove only installer-stored credentials |
| Confirm search provider | Automatic + credential correction gate | SearXNG is selected or the paid provider accepts a read-only test query | Remove only installer-stored credentials |
| Confirm WhatsApp | Optional manual + API check | Meta setup checklist and phone-number API check pass | Disable the channel; retain external Meta resources |
| Verify VPS | Automatic + trust gate | Ubuntu version, host fingerprint, root/passwordless sudo | Remove temporary remote installer files |
| Verify payload | Automatic | Signed manifest and SHA-256 match | Delete local staging files |
| Deploy release | Automatic | Remote detached job reports success; systemd health is ready | Activate retained previous release when present |
| Bootstrap Bitable | Automatic | Exact Leads and Events schemas validate | Keep tables; disable writes and record orphan resources |
| Pair Feishu | Manual + remote check | At least one approved alert destination is stored | Clear pairing code; do not remove user data silently |
| Final acceptance | Automatic | Fresh-install acceptance has zero failures | Keep global outbound pause and restore prior release on request |

## Safety Invariants

- A customer package never contains `.env`, API keys, passwords, private customer cases, leads, or the seller's production database.
- External sending remains paused after installation. The customer must explicitly approve and resume it in Feishu.
- Logs redact known secret values and common token/password patterns before disk or UI output.
- A failed release activation invokes the existing server-side rollback automatically.
- Installer rollback does not remove shared system components such as Docker, PowerShell, or OpenSSH. It only reverses resources owned by this product.
- Remote host keys require explicit trust on first connection and are pinned for later resumes.

## Packaging

The repository produces these Windows artifacts from one source tree:

- NSIS setup for Windows x64
- Portable executable for Windows x64
- NSIS setup for Windows arm64
- Portable executable for Windows arm64

GitHub Actions builds the same artifacts in a clean runner and publishes checksums. It also installs, self-tests, and uninstalls the x64 Setup and Portable builds on Windows Server 2022 and 2025. Code signing is optional during development; `v*` release tags fail unless the package launchers, packaged applications, and uninstallers have valid Authenticode signatures.
