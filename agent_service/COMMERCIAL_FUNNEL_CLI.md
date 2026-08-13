# Commercial Funnel CLI

Run the delivered-cohort commercial report from `agent_service`:

```powershell
npm run cli -- commercial-funnel
```

Optional snapshot boundaries use ISO 8601 timestamps. `start-at` is inclusive,
`end-at` is exclusive, and `generated-at` is the downstream-record snapshot
boundary:

```powershell
npm run cli -- commercial-funnel `
  --start-at 2026-07-01T00:00:00.000Z `
  --end-at 2026-08-01T00:00:00.000Z `
  --generated-at 2026-08-02T00:00:00.000Z
```

The command emits one JSON object containing the overall report, every
commercial dimension, descriptive FIRST/LAST/ASSIST touchpoint attribution,
unresolved-record counts, and calculation notes. The cohort requires stored
delivery evidence; a `SENT` status alone is explicitly excluded.

The CLI opens SQLite in read-only mode before any database initialization, and
the report adapter also enforces `query_only`. It does not run migrations or call
providers, Feishu, transports, content publishers, or any other external
integration. Run `npm run cli -- verify-db` separately when a copied database may
need migration or integrity checks.
