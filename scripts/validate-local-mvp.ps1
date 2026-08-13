param(
  [string]$MvpDir = ".\local_mvp_test_20260709"
)

$ErrorActionPreference = "Stop"

$requiredFiles = @(
  "keywords.md",
  "leads.csv",
  "contacts_enrichment.csv",
  "procurement_contact_validation.csv",
  "manual_verification_queue.csv",
  "verification_request_drafts.md",
  "outreach_drafts.md",
  "test_report.md",
  "README.md",
  "scoring_rules.md",
  "feishu_sheets_manual.md",
  "input_brief.example.yaml",
  "company_profile_template.md",
  "crm_import.csv",
  "outbound_messages.csv"
)

foreach ($file in $requiredFiles) {
  $path = Join-Path $MvpDir $file
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing required file: $path"
  }
}

$csvPath = Join-Path $MvpDir "leads.csv"
$rows = Import-Csv -LiteralPath $csvPath
if ($rows.Count -lt 10) {
  throw "Expected at least 10 leads, found $($rows.Count)."
}

$requiredColumns = @(
  "Priority",
  "Score",
  "Company Name",
  "Country",
  "Buyer Type",
  "Website",
  "Product Match",
  "Verification Source",
  "Source URLs",
  "Notes"
)

foreach ($col in $requiredColumns) {
  if (-not ($rows[0].PSObject.Properties.Name -contains $col)) {
    throw "Missing required CSV column: $col"
  }
}

$missingSources = $rows | Where-Object { [string]::IsNullOrWhiteSpace($_."Source URLs") }
if ($missingSources.Count -gt 0) {
  throw "Every lead must have a source URL. Missing: $($missingSources.Count)"
}

$invalidScores = $rows | Where-Object {
  $n = 0
  -not [int]::TryParse($_.Score, [ref]$n)
}
if ($invalidScores.Count -gt 0) {
  throw "Every lead score must be an integer. Invalid: $($invalidScores.Count)"
}

$prioritySummary = $rows | Group-Object Priority | Sort-Object Name | ForEach-Object {
  "$($_.Name)=$($_.Count)"
}

$contactsPath = Join-Path $MvpDir "contacts_enrichment.csv"
$contactRows = Import-Csv -LiteralPath $contactsPath
if ($contactRows.Count -lt 1) {
  throw "Expected at least one contact enrichment row."
}

$contactRequiredColumns = @(
  "Company",
  "Contact Name",
  "Title",
  "Contact Quality",
  "Public Source",
  "Source URL",
  "Recommended Next Step",
  "Notes"
)

foreach ($col in $contactRequiredColumns) {
  if (-not ($contactRows[0].PSObject.Properties.Name -contains $col)) {
    throw "Missing required contact enrichment column: $col"
  }
}

$missingContactSources = $contactRows | Where-Object { [string]::IsNullOrWhiteSpace($_."Source URL") }
if ($missingContactSources.Count -gt 0) {
  throw "Every contact enrichment row must have Source URL. Missing: $($missingContactSources.Count)"
}

$validationPath = Join-Path $MvpDir "procurement_contact_validation.csv"
$validationRows = Import-Csv -LiteralPath $validationPath
if ($validationRows.Count -lt 1) {
  throw "Expected at least one procurement contact validation row."
}

$validationRequiredColumns = @(
  "Company",
  "Contact Name",
  "Stated Title",
  "Validation Status",
  "Role Fit Score",
  "Company Fit Evidence",
  "Contact Evidence",
  "Source URLs",
  "Outreach Readiness",
  "Recommended Next Action",
  "Notes"
)

foreach ($col in $validationRequiredColumns) {
  if (-not ($validationRows[0].PSObject.Properties.Name -contains $col)) {
    throw "Missing required procurement validation column: $col"
  }
}

$missingValidationSources = $validationRows | Where-Object { [string]::IsNullOrWhiteSpace($_."Source URLs") }
if ($missingValidationSources.Count -gt 0) {
  throw "Every procurement validation row must have Source URLs. Missing: $($missingValidationSources.Count)"
}

$invalidRoleScores = $validationRows | Where-Object {
  $n = 0
  -not [int]::TryParse($_."Role Fit Score", [ref]$n)
}
if ($invalidRoleScores.Count -gt 0) {
  throw "Every procurement validation role fit score must be an integer. Invalid: $($invalidRoleScores.Count)"
}

$queuePath = Join-Path $MvpDir "manual_verification_queue.csv"
$queueRows = Import-Csv -LiteralPath $queuePath
if ($queueRows.Count -lt 1) {
  throw "Expected at least one manual verification queue row."
}

$queueRequiredColumns = @(
  "Company",
  "Target Contact",
  "Target Role",
  "Official Route",
  "Official Route URL",
  "Public Evidence URLs",
  "Verification Objective",
  "Draft Type",
  "Send Status",
  "Notes"
)

foreach ($col in $queueRequiredColumns) {
  if (-not ($queueRows[0].PSObject.Properties.Name -contains $col)) {
    throw "Missing required manual verification queue column: $col"
  }
}

$notBlockedFromSending = $queueRows | Where-Object { $_."Send Status" -ne "DO_NOT_SEND_YET" }
if ($notBlockedFromSending.Count -gt 0) {
  throw "Manual verification queue must remain DO_NOT_SEND_YET in MVP. Found: $($notBlockedFromSending.Count)"
}

$crmPath = Join-Path $MvpDir "crm_import.csv"
$crmRows = Import-Csv -LiteralPath $crmPath
if ($crmRows.Count -ne $rows.Count) {
  throw "CRM row count must match leads row count. Leads=$($rows.Count), CRM=$($crmRows.Count)"
}

$crmRequiredColumns = @(
  "created_at",
  "market",
  "product",
  "company",
  "website",
  "country",
  "buyer_type",
  "contact_name",
  "title",
  "email",
  "whatsapp",
  "linkedin",
  "source_url",
  "score",
  "grade",
  "match_reason",
  "recommended_channel",
  "email_draft",
  "whatsapp_opener",
  "status",
  "next_follow_up_at",
  "owner"
)

foreach ($col in $crmRequiredColumns) {
  if (-not ($crmRows[0].PSObject.Properties.Name -contains $col)) {
    throw "Missing required CRM column: $col"
  }
}

$missingCrmSources = $crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.source_url) }
if ($missingCrmSources.Count -gt 0) {
  throw "Every CRM row must have source_url. Missing: $($missingCrmSources.Count)"
}

$missingEmailDrafts = $crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.email_draft) }
if ($missingEmailDrafts.Count -gt 0) {
  throw "Every CRM row must have email_draft for manual review. Missing: $($missingEmailDrafts.Count)"
}

$missingWhatsAppOpeners = $crmRows | Where-Object { [string]::IsNullOrWhiteSpace($_.whatsapp_opener) }
if ($missingWhatsAppOpeners.Count -gt 0) {
  throw "Every CRM row must have whatsapp_opener for manual review. Missing: $($missingWhatsAppOpeners.Count)"
}

$outboundPath = Join-Path $MvpDir "outbound_messages.csv"
$outboundRows = Import-Csv -LiteralPath $outboundPath
$outboundRequiredColumns = @(
  "message_id",
  "company",
  "channel",
  "destination",
  "destination_type",
  "subject",
  "body",
  "approval_status",
  "source_url",
  "owner",
  "generated_at",
  "send_status",
  "sent_at",
  "notes"
)
if ($outboundRows.Count -lt 1) {
  throw "Expected at least one outbound review message."
}
foreach ($col in $outboundRequiredColumns) {
  if (-not ($outboundRows[0].PSObject.Properties.Name -contains $col)) {
    throw "Missing required outbound_messages column: $col"
  }
}
$emptyBodies = $outboundRows | Where-Object { [string]::IsNullOrWhiteSpace($_.body) }
if ($emptyBodies.Count -gt 0) {
  throw "Every outbound review message must have body text. Missing: $($emptyBodies.Count)"
}

Write-Host "[OK] MVP directory valid: $MvpDir"
Write-Host "[OK] Lead count: $($rows.Count)"
Write-Host "[OK] Priority summary: $($prioritySummary -join ', ')"
Write-Host "[OK] Contact enrichment rows: $($contactRows.Count)"
Write-Host "[OK] Procurement validation rows: $($validationRows.Count)"
Write-Host "[OK] Manual verification queue rows: $($queueRows.Count)"
Write-Host "[OK] CRM import rows: $($crmRows.Count)"
Write-Host "[OK] Outbound review messages: $($outboundRows.Count)"
