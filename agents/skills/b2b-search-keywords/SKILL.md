---
name: b2b-search-keywords
description: "Generate multilingual B2B customer-search keyword matrices from a product category, HS Code, and target market. Use when the user asks for foreign-trade search keywords, buyer keywords, HS-Code-based lead search terms, or multilingual B2B discovery queries."
---

# B2B Search Keywords

Generate search keyword packs that can be copied into Google, LinkedIn search, Facebook groups, WhatsApp group searches, trade-show searches, and local directories.

## Inputs

Ask:

- Product name and category.
- Known HS Code, if any.
- Target markets.
- New, used, refurbished, or both.
- Main buyer type.

## Workflow

1. Identify HS Code.
   - If product is compound, split components and search each component separately.
   - Treat HS Code suggestions as reference only; recommend confirmation with a customs broker.
   - First 6 digits are globally common; later digits may vary by country.

2. Split product tree.
   - Big category -> subcategories -> concrete product names.
   - If user provides HS Code, reverse-map to product names.

3. Generate 8 keyword layers.
   - English general: product + buyer type.
   - Local language: market-specific terms.
   - Brand/model/grade precision.
   - Industry use case.
   - Platform/trade show.
   - Used/refurbished terms.
   - Buyer persona terms.
   - Facebook/WhatsApp group terms.

4. Expand until useful volume is reached.
   - Variants: singular/plural/spelling.
   - Synonyms.
   - City and port names.
   - Industry deepening.
   - Upstream/downstream terms.
   - Search syntax variants.

## Buyer Type Words

Use these as a base:

| Language | Importer | Distributor | Wholesaler | Agent | Buyer |
| --- | --- | --- | --- | --- | --- |
| English | importer | distributor | wholesaler | agent | buyer |
| French | importateur | distributeur | grossiste | agent | acheteur |
| Portuguese | importador | distribuidor | atacadista | agente | comprador |
| Arabic | مستورد | موزع | جملة | وكيل | مشتري |
| Spanish | importador | distribuidor | mayorista | agente | comprador |
| Russian | импортёр | дистрибьютор | оптовик | агент | покупатель |
| Vietnamese | nhà nhập khẩu | nhà phân phối | bán buôn | đại lý | người mua |
| Indonesian | importir | distributor | grosir | agen | pembeli |
| Thai | ผู้นำเข้า | ผู้จัดจำหน่าย | ขายส่ง | ตัวแทน | ผู้ซื้อ |

## Used/Refurbished Words

| Language | Used | Refurbished | Pre-owned |
| --- | --- | --- | --- |
| English | used / second hand | refurbished / reconditioned | pre-owned |
| French | occasion | reconditionné | d'occasion |
| Portuguese | usado | recondicionado | em segunda mão |
| Arabic | مستعمل | مجدد | قديم |
| Spanish | usado | reacondicionado | de segunda mano |
| Russian | б/у | восстановленный | подержанный |
| Vietnamese | đã qua sử dụng | đã tân trang | cũ |
| Indonesian | bekas | direkondisi | second |
| Thai | มือสอง | ปรับปรุงใหม่ | เก่า |

## Output Format

```markdown
# 搜索关键词包：[产品中文名称]

## 产品品类树
| 总品类 | 子品类 | 具体产品 | HS Code | 新机/二手 |

## HS Code
| HS Code | 品名 | 说明 |

## 关键词矩阵
### 第1层：英语通用
### 第2层：本地语
### 第3层：牌号/型号精准
### 第4层：行业用途
### 第5层：平台/展会
### 第6层：二手/翻新
### 第7层：买家画像
### 第8层：Facebook/WhatsApp

## 港口城市关键词
## 政府/NGO项目关键词
## Google搜索模板
```

## Search Templates

```text
"{product}" "{buyer type}" "{market}"
site:linkedin.com/in "{industry}" "purchasing" "{market}"
site:alibaba.com "{product}" "{market}"
"{product}" "trade show" "{market}" 2025
{product} {market} group
{product} {market} WhatsApp group
```

## Product Splits

Build product-family, model, specification, and application splits only from the
current runtime brief. Do not infer or preload a product catalog in this skill.

After output, suggest testing one keyword in Google and iterating based on result precision.
