---
name: competitor-intel-pro
description: "Find importers and customers through customs data reverse lookup and overseas trade-show exhibitor lists. Use when the user asks for 海关数据, 竞品挖客, 展会找客户, importer discovery, competitor intel, or HS-Code/product import leads."
---

# Competitor Intel Pro

Use two complementary lead sources: customs data for proven import demand, and trade-show exhibitor lists for industry-fit prospects.

## Method 1: Customs Data

Input product keywords or HS Codes, then screen importer records.

### Three-Dimensional Screening

1. Recency.
   - Import in last 90 days: high priority.
   - Import in last 6 months: medium priority.
   - Older than 6 months: lower priority.

2. Frequency.
   - Monthly: P0 stable large buyer.
   - Quarterly: P1 stable medium buyer.
   - One-off: P2 trial/project buyer.
   - Irregular: P3 intermittent demand.

3. Volume fit.
   - 100-500 tons/month: often good fit for small/medium factory.
   - 500-2000 tons/month: larger buyer; check capacity.
   - Under 50 tons/month: small but possible.
   - Over 2000 tons/month: evaluate production and cash-flow risk.

### Deep Dive After Company Name

Do not contact directly. Research first:

```text
"{company}" company overview
"{company}" "annual report" OR "about us"
site:{company domain} about OR company OR profile
site:linkedin.com/in "{company}" procurement OR purchasing OR "supply chain"
site:linkedin.com/in "{company}" CEO OR "managing director" OR owner
"{company}" "@{company domain}" email
"{company}" China supplier OR import from China
```

## Method 2: Trade Shows

Trade-show exhibitor lists are precise industry directories, especially for companies that do not advertise heavily.

Search:

```text
"{product}" trade show OR exhibition {year} {country}
"{product}" trade fair exhibitor list
"{industry}" exhibition {country} {year}
"international" "{product}" expo
```

On exhibitor sites, look for `Exhibitor List`, `Exhibitor Directory`, `Brands`, `Product Categories`, `Floor Plan`, and `Find Exhibitors`.

Extract company, country, product description, website, social links, and booth number. Then validate with Google and LinkedIn.

## Output

```json
{
  "company": "Importer or exhibitor name",
  "country": "Country",
  "hs_codes": ["HS codes if customs source"],
  "products": ["Imported or exhibited product descriptions"],
  "screening": {
    "last_import_date": "YYYY-MM-DD",
    "frequency": "monthly/quarterly/occasional",
    "monthly_volume_tons": 300,
    "priority": "P0/P1/P2/P3"
  },
  "deep_dive": {
    "website": "Official site",
    "linkedin": "Company LinkedIn",
    "key_contacts": [],
    "estimated_size": "Company size",
    "has_china_supplier": true
  },
  "sources": []
}
```

## Merge Logic

Combine customs and exhibitor leads, dedupe by normalized company/domain, then score by demand proof, company fit, contact completeness, and source reliability.

## Notes

- Mark data dates and source URLs.
- Confirm exhibitor lists are recent.
- Respect API quota limits if using a customs data provider.
- Send verified companies to customer research for contact enrichment.
