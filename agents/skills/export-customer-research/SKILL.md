---
name: export-customer-research
description: "Research overseas B2B buyers, importers, distributors, and decision makers for foreign-trade sales. Use when the user asks to find foreign customers, importers, purchasing managers, buyer contacts, LinkedIn decision makers, or export customer development leads."
---

# Export Customer Research

Use this workflow to build a verified export lead list with named contacts. Generic inboxes are fallback only.

## First Questions

Before searching, clarify:

- Product category and key specs.
- Target countries or regions.
- B2B wholesale, distributor, importer, manufacturer, or retail target.
- Price segment or customer size.
- Required certifications or exclusions.

## Workflow

1. Search target companies.
   - Use product + buyer type + country queries.
   - Use country suffixes and local terms when relevant.
   - Use LinkedIn dorks for role discovery.

2. Find 2-4 decision makers per company.
   - Prefer Product Manager / Category Manager for retailers.
   - Prefer Purchasing / Procurement / Sourcing for larger firms.
   - Prefer CEO / Founder / Managing Director for small companies.
   - Mark Chinese-speaking sourcing contacts specially when found.

3. Validate each lead with multiple sources.
   - Layer 1: at least two sources mention the company.
   - Layer 2: website confirms product/customer fit.
   - Layer 3: at least one source confirms a named person.
   - Layer 4: email/phone format is plausible and source-backed.

4. Grade contact quality.
   - GOLD: named person + title + LinkedIn + verified personal email/phone.
   - SILVER: named person + title + inferred or partially verified email.
   - BRONZE: generic email such as `info@` or `sales@`.
   - BLACK: company only; skip or research later.

5. Export CSV and outreach notes.

## Search Patterns

```text
"Australia lighting wholesaler distributor importer chandelier pendant"
"site:.com.au lighting wholesaler pendant"
"{Company} management team purchasing product manager CEO"
site:linkedin.com/in "Purchasing Manager" "{company or industry}" "{country}"
site:linkedin.com/in "Procurement" "{product}" "{country}"
site:linkedin.com/in "Sourcing Manager" "{product}" "{country}"
```

## Scoring

- 4: company 2+ sources + LinkedIn person + verified email.
- 3: company 2+ sources + LinkedIn person.
- 2: LinkedIn name + one other source.
- 1: name + inferred email.
- 0: company only.

Start outreach when at least 3 GOLD contacts are found. If there are no GOLD and fewer than 5 SILVER, continue deep research.

## CSV Output

```csv
Priority,Company Name,Website,Contact Person,Job Title,Email,Phone,LinkedIn,Product Match,Verification Source,Notes
GOLD,Example Company,example.com,John Doe,Purchasing Manager,j@example.com,+1 234...,https://linkedin.com/in/...,wooden chandelier,LinkedIn+official website,150+ stores
```

## User Summary

Return:

- Total companies found.
- Total contacts found and GOLD count.
- Top recommended contacts.
- Data gaps and next actions.
- Optional cold email draft if requested.

## Safety

- Use only public information and user-provided data.
- Do not ask for or use the user's LinkedIn account.
- Do not send messages or emails; draft only unless explicitly authorized and confirmed.
- Do not promise access to paid databases unless available.
