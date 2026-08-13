param(
  [ValidateSet("Plan", "SendEmail", "SendWhatsAppTemplate")]
  [string]$Mode = "Plan",
  [string]$Workspace = "",
  [int]$MaxBatch = 10,
  [switch]$ConfirmExternalSend
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$dataDir = Join-Path $Workspace "product_data"
$queuePath = Join-Path $dataDir "outreach_approval_queue.csv"
$messagePath = Join-Path $dataDir "outbound_messages.csv"
$dncPath = Join-Path $dataDir "do_not_contact.csv"
$envPath = Join-Path $Workspace ".env"
$logDir = Join-Path $Workspace "outputs\outbound_dispatch"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$reportPath = Join-Path $logDir "outbound-dispatch-$stamp.json"
$sendLogPath = Join-Path $logDir "send-log.csv"

$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [string]$Area,
    [string]$Status,
    [string]$Detail
  )
  $safe = $Detail -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  $safe = $safe -replace '(?i)(password|secret|token|api_key)\s*[:=]\s*[^,\s;]+', '$1=REDACTED'
  $results.Add([pscustomobject]@{ area = $Area; status = $Status; detail = $safe }) | Out-Null
  $tag = if ($Status -eq "OK") { "[OK]" } elseif ($Status -eq "WARN") { "[WARN]" } else { "[BLOCKED]" }
  Write-Host "$tag $Area $safe"
}

function Get-EnvMap {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $map[$parts[0].Trim()] = $parts[1].Trim()
  }
  return $map
}

function Normalize-Target {
  param([string]$Value)
  if ($null -eq $Value) { return "" }
  return $Value.Trim().ToLowerInvariant()
}

function Is-EmailAddress {
  param([string]$Value)
  return $Value -match '^[^@\s]+@[^@\s]+\.[^@\s]+$'
}

function Normalize-WhatsAppNumber {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  return ($Value -replace '[^\d]', '')
}

function Is-WhatsAppNumber {
  param([string]$Value)
  $digits = Normalize-WhatsAppNumber $Value
  return $digits -match '^\d{8,15}$'
}

function Test-PositiveInt {
  param([string]$Value)
  $parsed = 0
  return [int]::TryParse($Value, [ref]$parsed) -and $parsed -gt 0
}

function Get-MessageField {
  param(
    [object]$Message,
    [string]$Name
  )
  if ($Message.PSObject.Properties.Name -contains $Name) {
    return [string]$Message.$Name
  }
  return ""
}

function Set-RowValue {
  param(
    [object]$Row,
    [string]$Name,
    [string]$Value
  )
  if ($Row.PSObject.Properties.Name -contains $Name) {
    $Row.$Name = $Value
  } else {
    $Row | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function New-WhatsAppTemplatePayload {
  param(
    [object]$Message,
    [hashtable]$EnvMap
  )

  $template = @{
    name = $EnvMap.WHATSAPP_TEMPLATE_NAME
    language = @{
      code = $EnvMap.WHATSAPP_TEMPLATE_LANGUAGE
    }
  }

  $paramFields = @()
  if (-not [string]::IsNullOrWhiteSpace($EnvMap.WHATSAPP_TEMPLATE_BODY_PARAM_FIELDS)) {
    $paramFields = @($EnvMap.WHATSAPP_TEMPLATE_BODY_PARAM_FIELDS -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
  if ($paramFields.Count -gt 0) {
    $parameters = @()
    foreach ($field in $paramFields) {
      $value = Get-MessageField -Message $Message -Name $field
      if ([string]::IsNullOrWhiteSpace($value)) {
        $value = $field
      }
      $parameters += @{
        type = "text"
        text = $value
      }
    }
    $template.components = @(
      @{
        type = "body"
        parameters = $parameters
      }
    )
  }

  return @{
    messaging_product = "whatsapp"
    to = (Normalize-WhatsAppNumber $Message.destination)
    type = "template"
    template = $template
  }
}

Write-Host "== Outbound dispatch =="
Write-Host "Mode: $Mode"
Write-Host "Workspace: $Workspace"

$approvalOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace "scripts\validate-outbound-approval.ps1") -Workspace $Workspace 2>&1
$approvalExit = $LASTEXITCODE
if ($approvalExit -ne 0) {
  Add-Result "Approval gate" "BLOCKED" (($approvalOutput | Select-Object -Last 8) -join " | ")
  $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  exit 1
}
Add-Result "Approval gate" "OK" "approval queue and do-not-contact schema passed"

if (-not (Test-Path -LiteralPath $messagePath)) {
  Add-Result "Outbound messages" "BLOCKED" "missing outbound_messages.csv; run build-outbound-messages.ps1 first"
  $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  exit 1
}

$messages = @(Import-Csv -LiteralPath $messagePath -Encoding UTF8)
$queueRows = @(Import-Csv -LiteralPath $queuePath -Encoding UTF8)
$dnc = if (Test-Path -LiteralPath $dncPath) { @(Import-Csv -LiteralPath $dncPath -Encoding UTF8) } else { @() }
$dncValues = New-Object System.Collections.Generic.HashSet[string]
foreach ($entry in $dnc) {
  $value = Normalize-Target $entry.value
  if (-not [string]::IsNullOrWhiteSpace($value)) { [void]$dncValues.Add($value) }
}

$approved = @($messages | Where-Object {
  ([string]$_.approval_status).Trim().ToUpperInvariant() -eq "APPROVED" -and
  [string]::IsNullOrWhiteSpace($_.sent_at)
})

$blockedByDnc = @($approved | Where-Object {
  $dncValues.Contains((Normalize-Target $_.company)) -or $dncValues.Contains((Normalize-Target $_.destination))
})
if ($blockedByDnc.Count -gt 0) {
  Add-Result "Do-not-contact gate" "BLOCKED" ("approved rows match DNC: " + (($blockedByDnc | Select-Object -First 5 | ForEach-Object { $_.company }) -join ", "))
} else {
  Add-Result "Do-not-contact gate" "OK" "approved rows do not match do_not_contact.csv"
}

$batch = @($approved | Select-Object -First $MaxBatch)
Add-Result "Dispatch plan" "OK" "messages=$($messages.Count); approved=$($approved.Count); selected=$($batch.Count); max_batch=$MaxBatch"

if ($Mode -eq "Plan") {
  $preview = @($batch | Select-Object message_id, company, channel, destination_type, destination, subject, approval_status)
  $summary = [pscustomobject]@{
    mode = $Mode
    generated_at = (Get-Date -Format s)
    selected = $preview
    results = $results
  }
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Host "[OK] Plan only; no external messages sent."
  Write-Host "[OK] Report written: $reportPath"
  if (@($results | Where-Object { $_.status -eq "BLOCKED" }).Count -gt 0) { exit 1 }
  exit 0
}

if ($Mode -eq "SendEmail") {
  if (-not $ConfirmExternalSend) {
    Add-Result "External send confirmation" "BLOCKED" "SendEmail requires -ConfirmExternalSend"
  }

  $envMap = Get-EnvMap $envPath
  $requiredEnv = @("EMAIL_OUTREACH_ENABLED", "EMAIL_SEND_REQUIRES_CONFIRMATION", "EMAIL_FROM_ADDRESS", "EMAIL_FROM_NAME", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_DAILY_LIMIT", "EMAIL_HOURLY_LIMIT", "EMAIL_UNSUBSCRIBE_TEXT")
  $missingEnv = @($requiredEnv | Where-Object { [string]::IsNullOrWhiteSpace($envMap[$_]) })
  if ($missingEnv.Count -gt 0) {
    Add-Result "Email config" "BLOCKED" ("missing " + ($missingEnv -join ", "))
  } elseif ($envMap.EMAIL_OUTREACH_ENABLED -ne "true") {
    Add-Result "Email config" "BLOCKED" "EMAIL_OUTREACH_ENABLED must be true"
  } elseif ($envMap.EMAIL_SEND_REQUIRES_CONFIRMATION -ne "true") {
    Add-Result "Email config" "BLOCKED" "EMAIL_SEND_REQUIRES_CONFIRMATION must remain true"
  } else {
    Add-Result "Email config" "OK" "SMTP settings present and confirmation flag enabled"
  }

  $emailBatch = @($batch | Where-Object { $_.destination_type -match 'email' -and (Is-EmailAddress $_.destination) })
  $nonEmail = $batch.Count - $emailBatch.Count
  if ($nonEmail -gt 0) {
    Add-Result "Email batch filter" "WARN" "$nonEmail approved rows are not email destinations and will not be sent by SendEmail"
  }
  if ($emailBatch.Count -eq 0) {
    Add-Result "Email batch" "WARN" "no approved email rows selected"
  }

  if (@($results | Where-Object { $_.status -eq "BLOCKED" }).Count -gt 0) {
    $results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host "[OK] Report written: $reportPath"
    exit 1
  }

  $smtp = New-Object System.Net.Mail.SmtpClient($envMap.SMTP_HOST, [int]$envMap.SMTP_PORT)
  $smtp.EnableSsl = $true
  $smtp.Credentials = New-Object System.Net.NetworkCredential($envMap.SMTP_USER, $envMap.SMTP_PASSWORD)

  $sentRows = New-Object System.Collections.Generic.List[object]
  foreach ($message in $emailBatch) {
    $body = [string]$message.body
    if ($body -notmatch [regex]::Escape($envMap.EMAIL_UNSUBSCRIBE_TEXT)) {
      $body = $body.TrimEnd() + "`r`n`r`n" + $envMap.EMAIL_UNSUBSCRIBE_TEXT
    }
    $mail = New-Object System.Net.Mail.MailMessage
    $mail.From = New-Object System.Net.Mail.MailAddress($envMap.EMAIL_FROM_ADDRESS, $envMap.EMAIL_FROM_NAME)
    $mail.To.Add($message.destination)
    $mail.Subject = $message.subject
    $mail.Body = $body
    $mail.IsBodyHtml = $false
    $smtp.Send($mail)
    $sentAt = Get-Date -Format s
    $sentRows.Add([pscustomobject]@{
      sent_at = $sentAt
      message_id = $message.message_id
      company = $message.company
      channel = "email"
      destination = $message.destination
      subject = $message.subject
    }) | Out-Null
    Set-RowValue $message "send_status" "SENT"
    Set-RowValue $message "sent_at" $sentAt
    foreach ($queueRow in $queueRows) {
      if ((Normalize-Target $queueRow.company) -eq (Normalize-Target $message.company) -and
          (Normalize-Target $queueRow.destination) -eq (Normalize-Target $message.destination)) {
        Set-RowValue $queueRow "approval_status" "SENT"
        Set-RowValue $queueRow "sent_at" $sentAt
      }
    }
    Add-Result "Email sent" "OK" "$($message.company) <$($message.destination)>"
  }

  if ($sentRows.Count -gt 0) {
    if (Test-Path -LiteralPath $sendLogPath) {
      $sentRows | Export-Csv -LiteralPath $sendLogPath -NoTypeInformation -Append -Encoding UTF8
    } else {
      $sentRows | Export-Csv -LiteralPath $sendLogPath -NoTypeInformation -Encoding UTF8
    }
    $messages | Export-Csv -LiteralPath $messagePath -NoTypeInformation -Encoding UTF8
    $queueRows | Export-Csv -LiteralPath $queuePath -NoTypeInformation -Encoding UTF8
  }
}

if ($Mode -eq "SendWhatsAppTemplate") {
  if (-not $ConfirmExternalSend) {
    Add-Result "External send confirmation" "BLOCKED" "SendWhatsAppTemplate requires -ConfirmExternalSend"
  }

  $envMap = Get-EnvMap $envPath
  $requiredEnv = @(
    "WHATSAPP_OUTREACH_ENABLED",
    "WHATSAPP_BUSINESS_API_ENABLED",
    "WHATSAPP_GRAPH_API_VERSION",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_TEMPLATE_NAME",
    "WHATSAPP_TEMPLATE_LANGUAGE",
    "WHATSAPP_DAILY_LIMIT",
    "WHATSAPP_SEND_REQUIRES_CONFIRMATION"
  )
  $missingEnv = @($requiredEnv | Where-Object { [string]::IsNullOrWhiteSpace($envMap[$_]) })
  if ($missingEnv.Count -gt 0) {
    Add-Result "WhatsApp config" "BLOCKED" ("missing " + ($missingEnv -join ", "))
  } elseif ($envMap.WHATSAPP_OUTREACH_ENABLED -ne "true") {
    Add-Result "WhatsApp config" "BLOCKED" "WHATSAPP_OUTREACH_ENABLED must be true"
  } elseif ($envMap.WHATSAPP_BUSINESS_API_ENABLED -ne "true") {
    Add-Result "WhatsApp config" "BLOCKED" "WHATSAPP_BUSINESS_API_ENABLED must be true"
  } elseif ($envMap.WHATSAPP_SEND_REQUIRES_CONFIRMATION -ne "true") {
    Add-Result "WhatsApp config" "BLOCKED" "WHATSAPP_SEND_REQUIRES_CONFIRMATION must remain true"
  } elseif (-not (Test-PositiveInt $envMap.WHATSAPP_DAILY_LIMIT)) {
    Add-Result "WhatsApp limits" "BLOCKED" "WHATSAPP_DAILY_LIMIT must be a positive integer"
  } else {
    Add-Result "WhatsApp config" "OK" "Business API template settings present and confirmation flag enabled"
  }

  $whatsappBatch = @($batch | Where-Object { $_.destination_type -match 'whatsapp' -and (Is-WhatsAppNumber $_.destination) })
  $nonWhatsApp = $batch.Count - $whatsappBatch.Count
  if ($nonWhatsApp -gt 0) {
    Add-Result "WhatsApp batch filter" "WARN" "$nonWhatsApp approved rows are not WhatsApp destinations and will not be sent by SendWhatsAppTemplate"
  }
  if ($whatsappBatch.Count -eq 0) {
    Add-Result "WhatsApp batch" "WARN" "no approved WhatsApp rows selected"
  }

  if (@($results | Where-Object { $_.status -eq "BLOCKED" }).Count -gt 0) {
    $results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host "[OK] Report written: $reportPath"
    exit 1
  }

  $sentRows = New-Object System.Collections.Generic.List[object]
  foreach ($message in $whatsappBatch) {
    $payload = New-WhatsAppTemplatePayload -Message $message -EnvMap $envMap
    $uri = "https://graph.facebook.com/$($envMap.WHATSAPP_GRAPH_API_VERSION)/$($envMap.WHATSAPP_PHONE_NUMBER_ID)/messages"
    $headers = @{
      Authorization = "Bearer $($envMap.WHATSAPP_ACCESS_TOKEN)"
      "Content-Type" = "application/json"
    }
    $resp = Invoke-RestMethod `
      -Method Post `
      -Uri $uri `
      -Headers $headers `
      -Body ($payload | ConvertTo-Json -Depth 12 -Compress)
    $sentAt = Get-Date -Format s
    $providerId = ""
    try {
      if ($resp.messages -and $resp.messages.Count -gt 0) {
        $providerId = [string]$resp.messages[0].id
      }
    } catch {
      $providerId = ""
    }
    $sentRows.Add([pscustomobject]@{
      sent_at = $sentAt
      message_id = $message.message_id
      company = $message.company
      channel = "whatsapp"
      destination = $message.destination
      subject = $message.subject
      provider_message_id = $providerId
    }) | Out-Null
    Set-RowValue $message "send_status" "SENT"
    Set-RowValue $message "sent_at" $sentAt
    foreach ($queueRow in $queueRows) {
      if ((Normalize-Target $queueRow.company) -eq (Normalize-Target $message.company) -and
          (Normalize-Target $queueRow.destination) -eq (Normalize-Target $message.destination)) {
        Set-RowValue $queueRow "approval_status" "SENT"
        Set-RowValue $queueRow "sent_at" $sentAt
      }
    }
    Add-Result "WhatsApp sent" "OK" "$($message.company) <$($message.destination)> provider_id=$providerId"
  }

  if ($sentRows.Count -gt 0) {
    if (Test-Path -LiteralPath $sendLogPath) {
      $sentRows | Export-Csv -LiteralPath $sendLogPath -NoTypeInformation -Append -Encoding UTF8
    } else {
      $sentRows | Export-Csv -LiteralPath $sendLogPath -NoTypeInformation -Encoding UTF8
    }
    $messages | Export-Csv -LiteralPath $messagePath -NoTypeInformation -Encoding UTF8
    $queueRows | Export-Csv -LiteralPath $queuePath -NoTypeInformation -Encoding UTF8
  }
}

$final = [pscustomobject]@{
  mode = $Mode
  generated_at = (Get-Date -Format s)
  results = $results
}
$final | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "[OK] Report written: $reportPath"

if (@($results | Where-Object { $_.status -eq "BLOCKED" }).Count -gt 0) {
  exit 1
}
exit 0
