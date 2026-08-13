---
name: customer-discovery-pro
description: "Discover and verify overseas customers through Google search, Google Maps, WhatsApp-number searches, local yellow pages, and directories. Use for full-channel customer discovery, market-specific lead search, and cross-validated B2B lead generation."
---

# Customer Discovery Pro

Use a five-layer funnel: broad search, Maps, WhatsApp, local directories, then dedupe and validation.

## Inputs

- Product terms or HS Code.
- Target countries, cities, or regions.
- Buyer type: importer, distributor, wholesaler, dealer, manufacturer, contractor, etc.
- Preferred contact channels and exclusions.

## Layer 1: Google Keyword Search

Formula:

```text
{product term} + {buyer identity term} + {country/city}
```

Shrink queries when results are sparse:

```text
"SK5" "steel strip" importer Vietnam
"SK5" "steel strip" Vietnam
"SK5" importer
"steel strip" Vietnam buyer
```

Use dorks:

```text
site:linkedin.com/in "procurement" "steel" {country}
"@{domain}" email OR contact
filetype:pdf "steel strip" catalog OR directory {country}
intitle:"steel strip" intitle:buyer OR importer
```

## Layer 2: Google Maps

Search entity-rich local terms:

```text
site:google.com/maps "steel strip manufacturer" "Vietnam" "Ho Chi Minh"
site:google.com/maps "spring factory" "Mexico" "Monterrey"
site:google.com/maps "metal stamping" "UAE" "Dubai"
```

Extract company name, address, phone, website, hours, and reviews. Re-search company name + product, company + LinkedIn, and company + email.

## Layer 3: WhatsApp

Search:

```text
{product term} WhatsApp {country code}
{grade/model} WhatsApp {country code}
{product term} {country} WhatsApp
```

Common codes: Taiwan +886, Vietnam +84, Mexico +52, UAE +971, India +91, Germany +49, Brazil +55, Turkey +90, Saudi +966, Indonesia +62.

Validate every number by searching the number + company, number + product, and number + scam/fraud.

## Layer 4: Local Directories

Use local platforms by region:

- Middle East: `yellowpages.ae`, `atninfo.com`, `yellowpages.com.sa`, `dubiki.com`.
- Europe: `europages.com`, `wlw.de`, `kompass.com`, `cylex.de`.
- Latin America: `paginasamarillas.com.mx`, `guiatelefonica.com.ar`, Brazil local directories.
- Australia: `hotfrog.com.au`, `truelocal.com.au`, `yellowpages.com.au`.
- Russia/CIS: Yandex Maps, `pulscen.ru`.

## Layer 5: Dedupe, Verify, Score

Require at least two independent sources before a lead is considered valid.

Score:

- +3 email found.
- +2 phone or WhatsApp found.
- +1 website found.
- +2 named contact + title.
- +2 full address.
- +1 product match.
- +3 two or more source confirmations.
- +2 official website + LinkedIn confirmation.
- -1 Maps-only lead.
- -1 WhatsApp mismatch.

## Output

```json
{
  "company": "Company name",
  "country": "Country",
  "city": "City",
  "product_match": "Matched product",
  "contacts": {
    "name": "Contact",
    "title": "Title",
    "email": "Email",
    "phone": "Phone",
    "whatsapp": "WhatsApp"
  },
  "address": "Full address",
  "website": "Official website",
  "score": 7,
  "sources": ["Google Maps", "LinkedIn"],
  "verified": true,
  "notes": ""
}
```

Record source URLs and uncertainty. Do not contact leads unless explicitly asked and confirmed.
