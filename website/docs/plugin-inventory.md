# Plugin Inventory

The local build uses a deliberately small free plugin set. Versions were checked against the WordPress.org API on 2026-07-23.

| Plugin | Local version | Purpose | Configuration status |
|---|---:|---|---|
| Rank Math SEO | 1.0.274.1 | Canonical URLs, metadata, Open Graph, schema, sitemap, 404 monitoring and redirects | Version pinned by the local provisioner; production host and final metadata pending |
| Fluent Forms | 6.2.8 | Inquiry form, validation, local entry storage and export | Version pinned by the local provisioner; Demo Manufacturer inquiry form bootstrapped |
| WP Mail SMTP | 4.9.0 | Authenticated form email delivery | Version pinned by the local provisioner; provider and credentials pending |
| UpdraftPlus | 1.26.5 | Scheduled application backup and restore | Version pinned by the local provisioner; off-site destination and restore test pending |

Do not install a second SEO or redirection plugin while Rank Math owns those outputs. Server-level snapshots remain required in addition to UpdraftPlus.

`scripts/provision-local.ps1` verifies these exact versions on every local run. A missing or different version is installed from WordPress.org with WP-CLI and then activated; an already matching installation is left in place. Version changes must be reviewed and updated in the script and this inventory together.
