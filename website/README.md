# Demo Manufacturer Website Rebuild

Sanitized demonstration of a self-hosted WordPress B2B catalog and inquiry website.

## Demonstration Identity

- Public company name: Demo Manufacturer
- Brand: Demo Manufacturer
- Placeholder domain: `example.com`
- Placeholder legacy domain: `legacy.example`
- Inquiry email: `sales@example.com`
- WhatsApp: `+1 555 010 0000`
- Architecture: WordPress with a custom lightweight theme and a companion business plugin

## Delivery Rules

- Build and verify on a local or staging environment before any DNS change.
- Keep the existing public site available until acceptance.
- Preserve existing public paths or add explicit permanent redirects.
- Do not publish unsupported claims, certifications, project results, or specifications.
- Never store production credentials in this repository.
- Back up the existing deployment and DNS state before cutover.

## Local Runtime

The local stack uses official WordPress and MariaDB images pinned to reviewed versions:

- WordPress 7.0.2 on PHP 8.3
- MariaDB 11.4.12
- WP-CLI 2.12.0 as an opt-in tools container

1. Create a local `.env` from `.env.example` with unique local-only passwords.
2. Start Docker Desktop.
3. Keep `WORDPRESS_URL` on `localhost` or a loopback IP and make its port match `WORDPRESS_PORT`.
4. Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\provision-local.ps1` from this directory.
5. Open the local URL printed by the script.

The provisioner starts the stack with health waiting, installs WordPress only when the database is new, pins and activates the reviewed plugin versions, activates the Demo Manufacturer theme and companion plugin, runs the idempotent content bootstrap, and flushes rewrite rules. Re-running the same command is supported. It does not print database or WordPress administrator passwords.

Migration-candidate images are excluded by default. For local rights review only, pass `-IncludeMigrationMedia`; these images remain blocked from production use until ownership is confirmed.

The web container is bound to `127.0.0.1` only. The database has no host port, so it does not conflict with or expose the workstation's existing MySQL service.

Both the provisioner and bootstrap are restricted to the isolated local Docker environment; the provisioner rejects non-loopback site URLs.

## Verification

Run `powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1` while the local stack is running. It verifies the 20 legacy routes, approved public identity, forbidden old identity values, database-error-free output, the public content author and the Rank Math sitemap index.

## Launch Gate

Before any staging-to-production cutover, run `docker compose run --rm wpcli wp eval-file /opt/demo_manufacturer-tools/launch-readiness.php`. This read-only gate reports missing owner information, placeholder products, unconfirmed migration media, unauthenticated mail, incomplete backups, missing components and unauthorized cases. It does not delete test submissions or QA logs.

The current local database is expected to fail this gate until the owner materials and production services are supplied. Follow `docs/launch-runbook.zh-CN.md` for staging, inbox, backup-restore, DNS and rollback checks.

## Current Phase

The local foundation is implemented as a demonstration. Public launch remains blocked until the operator supplies and verifies their own legal identity, products, media rights, specifications, downloadable documents, case authorization, SMTP, backups and canonical host.

See `docs/material-intake-checklist.zh-CN.md` for the owner submission checklist. Existing-site images in the local preview remain migration candidates only and must not be deployed until ownership and factual relevance are confirmed.
