---
name: feishu-sheets
description: "Read, write, append, and inspect Feishu/Lark Sheets through Feishu Open Platform APIs. Use when the user asks Codex to operate 飞书表格/Sheets, import CRM rows, query sheet metadata, append leads, or manage structured spreadsheet data via API credentials."
---

# Feishu Sheets

Use Feishu Open Platform APIs for spreadsheet CRUD-like data operations. Treat writes as external side effects: confirm the exact destination spreadsheet and rows before modifying live data unless the user has already authorized that specific write.

## Scope

Do:

- Read spreadsheet metadata and sheet list.
- Read cell ranges.
- Write/update cell ranges.
- Append rows.
- Batch import customer or sales data.

Do not do by default:

- Delete spreadsheets or sheets.
- Change styling, row heights, column widths, or structure.
- Hard-code app secrets.

## Setup Checklist

1. Create an internal Feishu app at `open.feishu.cn/app`.
2. Enable permissions as needed:
   - `sheets:spreadsheet`
   - `sheets:spreadsheet:readonly`
   - `sheets:spreadsheet.meta:read`
3. Publish a new app version after permission changes.
4. Store credentials in environment variables:

```bash
export FEISHU_APP_ID="cli_xxxxxxxx"
export FEISHU_APP_SECRET="your_app_secret_here"
```

Never ask the user to paste secrets into committed files or scripts.

## Token

Get `tenant_access_token`, valid for about 2 hours:

```bash
curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}"
```

Use `Authorization: Bearer $TOKEN` for all sheet calls.

## Core Endpoints

- Metadata: `GET /open-apis/sheets/v3/spreadsheets/{spreadsheetToken}`
- Sheet list: `GET /open-apis/sheets/v3/spreadsheets/{spreadsheetToken}/sheets/query`
- Read range: `GET /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values/{sheetId}!A1:T10`
- Write range: `PUT /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values`
- Append rows: `POST /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values_append`

Range format is `{sheetId}!{startCol}{startRow}:{endCol}{endRow}`.

## Write Payload

```json
{
  "valueRange": {
    "range": "{sheetId}!A1:D2",
    "values": [
      ["公司名", "联系人", "电话", "邮箱"],
      ["ABC Ltd", "John", "+1-555-0100", "john@abc.com"]
    ]
  }
}
```

PUT overwrites the target range. Use append when adding new CRM rows.

## Common CRM Columns

Use this default when the user has no schema:

`公司名称, 官网, 联系人, 职位, 邮箱, 国家, 客户等级, 电话, 备注, 录入时间, 跟进状态`

## Errors

- `99991672`: missing permission; enable `sheets:spreadsheet` and publish app.
- `99991661`: invalid/missing token; verify bearer header.
- `99991442`: spreadsheet not found; verify `spreadsheetToken`.

## Safety

- Redact app IDs, app secrets, tokens, and spreadsheet URLs before sharing logs.
- Confirm before writing to a shared or production spreadsheet.
- Preserve a local CSV backup before large writes when feasible.
