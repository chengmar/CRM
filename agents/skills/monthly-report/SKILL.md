---
name: monthly-report
description: "Maintain JSONL work logs and generate monthly or historical team reports from bot activity records. Use when the user asks for 发月报, 工作总结, 本月干了什么, 上月数据, comparing months, or summarizing AI-team activity logs."
---

# Monthly Report

Use lightweight JSONL logs as persistent team memory. Generate reports only when the user asks.

## Log Location

Default:

```text
shared-data/metrics/
├── kelai-log.jsonl
├── songxin-log.jsonl
├── shunmei-log.jsonl
├── amei-log.jsonl
├── wok-log.jsonl
└── awang-log.jsonl
```

Adapt names to the user's bot/team names. Do not delete or rotate logs unless explicitly asked.

## Log Format

Append one JSON object per completed task:

```json
{"date":"2026-05-30","type":"customer_search","summary":"土耳其SK5买家搜索","result":"17条线索，9条验证通过","market":"土耳其","grade":"SK5"}
```

Required fields:

- `date`: `YYYY-MM-DD`.
- `type`: task type.
- `summary`: what was done.
- `result`: quantified result.

Optional: `market`, `grade`, `contact`, `notes`.

## Suggested Types

| Bot | Types |
| --- | --- |
| 客来 | `customer_search`, `email_verify`, `deep_dive` |
| 送信仔 | `email_sent`, `reply_received`, `follow_up` |
| 顺妹 | `quote_created`, `product_image` |
| 啊妹 | `crm_import`, `doc_organize`, `skill_extract` |
| Wok | `competitor_watch`, `customs_reverse`, `lead_scored` |
| 啊旺 | `task_dispatch`, `team_summary`, `boss_report` |

## User Commands

- "发月报": summarize previous month.
- "发5月月报": summarize specified month.
- "所有人发月报": summarize all bot logs.
- "对比5月和7月": compare two months.
- "最近三个月汇总": aggregate a rolling period.

## Report Template

```markdown
📊 {Bot名} — {YYYY年MM月}工作总结

## 数据概览
| 类型 | 次数 |

## 市场覆盖
{market counts}

## 本月重点
- {top outputs}

## 困难/阻塞
- {if any}

## 下月计划
- {one-line plan}

数据来源：shared-data/metrics/{bot名}-log.jsonl
```

## Reading Logic

```python
import json
from collections import Counter

def read_month_logs(path, year_month):
    records = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                row = json.loads(line)
                if row.get("date", "").startswith(year_month):
                    records.append(row)
    return records

def summarize(records):
    return {
        "types": dict(Counter(r["type"] for r in records if r.get("type"))),
        "markets": dict(Counter(r.get("market") for r in records if r.get("market"))),
        "total": len(records),
    }
```

## Rules

- Log immediately after work; do not reconstruct fabricated history.
- Prefer numbers over vague words.
- Record blockers honestly.
- If there is no work, report "本月无任务".
