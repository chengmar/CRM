# Acquisition Control Tables in Bitable

Control-table export is separate from the legacy `Leads` and `Events` sync. It
is disabled by default:

```text
FEISHU_BITABLE_CONTROL_SYNC_ENABLED=false
```

An existing Leads/Events configuration continues to validate and sync without
the four control tables. Enabling control export requires either all four
explicit table IDs or ownership markers written to the local SQLite database by
an explicit `bootstrap-bitable` operation.

## Bootstrap And Ownership

Explicit bootstrap creates and validates these generated mirror tables:

- `Agent Campaign Briefs`
- `Agent Market Allocations`
- `Agent Sales Tasks`
- `Agent Commercial Report`

Bootstrap never selects a control table by display name. A customer table with
the same name is left untouched. It reuses only a table ID supplied explicitly
in configuration or a versioned local ownership marker from an earlier explicit
bootstrap. The returned IDs can also be configured directly:

```text
FEISHU_BITABLE_CAMPAIGN_BRIEFS_TABLE_ID=
FEISHU_BITABLE_MARKET_ALLOCATIONS_TABLE_ID=
FEISHU_BITABLE_SALES_TASKS_TABLE_ID=
FEISHU_BITABLE_COMMERCIAL_REPORT_TABLE_ID=
```

Partial ID sets are rejected. After reviewing the generated tables, set
`FEISHU_BITABLE_CONTROL_SYNC_ENABLED=true` to opt in.

## Authoritative Sync

SQLite remains authoritative. The sync reads remote records only to reconcile
record IDs; it never imports remote business fields. Known records are patched
from complete local field mappings, including explicit empty values that clear
stale optional fields.

Remote records with an empty, modified, legacy, or locally unknown primary key
stop the affected control sync and report the offending keys. Known duplicate
keys from concurrent or ambiguous creates are reconciled deterministically,
extra duplicate records are deleted, and the table is read again before any
updates continue. Unknown records are never silently accepted or deleted.

Campaign Brief rows include the complete review surface: market, product,
buyer types, industries, role families, qualification tracks, required signals,
exclusions, target, provider and research budgets, offers, transport, deadline,
hypothesis, hashes, and scoped authorization flags. Sales Task rows include
account, person, play, enrollment, and opportunity IDs.

## Commercial Rows

Commercial rows use two non-overlapping layouts:

- `FUNNEL_COUNTS`: one row per period and dimensional slice. It contains the
  delivered-account denominator and funnel counts, with all money fields empty.
- `CURRENCY_MONEY`: one row per period, dimensional slice, and currency. It
  contains revenue/margin minor units and exact provider `cost_micros`, with all
  funnel count fields empty.

Currencies are never converted or combined. `SENT` alone remains excluded from
the delivered-evidence cohort. Rows produced by the earlier mixed
count-and-currency layout are rejected and must be removed or moved to an
archive table before enabling the new sync.
