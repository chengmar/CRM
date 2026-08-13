param(
  [string]$Workspace = "",
  [string]$EnvPath = "",
  [switch]$RequireEnabled
)

$ErrorActionPreference = "Stop"

function Protect-Detail {
  param([AllowNull()][object]$Text)
  $safe = [string]$Text
  if ([string]::IsNullOrEmpty($safe)) { return "" }
  $safe = $safe -replace '(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', '[EMAIL_REDACTED]'
  $safe = $safe -replace '(?i)(://)[^/\s:@]+:[^@/\s]+@', '${1}REDACTED@'
  $safe = $safe -replace '(?i)(["'']?Authorization["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|(?:Bearer|Basic)\s+[^\s,;&}\]\r\n]+|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)((?:--?|/)[A-Za-z0-9_.-]*(?:password|token|key|secret)[A-Za-z0-9_.-]*\s+)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)(["'']?[A-Za-z0-9_.-]*(?:password|token|key|secret)[A-Za-z0-9_.-]*["'']?\s*[:=]\s*)(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\s,;&}\]\r\n]+)', '${1}REDACTED'
  $safe = $safe -replace '(?i)(\b(?:Bearer|Basic)\s+)[^\s,;&}\]\r\n]+', '${1}REDACTED'
  $safe = $safe -replace 'sk-[A-Za-z0-9_-]{12,}', 'sk-REDACTED'
  if ($safe.Length -gt 2000) { $safe = $safe.Substring($safe.Length - 2000) }
  return $safe
}

if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($EnvPath)) {
  $EnvPath = Join-Path $Workspace ".env"
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

function Assert-Present {
  param([hashtable]$Map, [string[]]$Keys)
  $missing = @($Keys | Where-Object { [string]::IsNullOrWhiteSpace($Map[$_]) })
  if ($missing.Count -gt 0) {
    throw "Missing email auth config: $($missing -join ', ')"
  }
}

function Read-SmtpReply {
  param([System.IO.StreamReader]$Reader)
  $lines = New-Object System.Collections.Generic.List[string]
  while ($true) {
    $line = $Reader.ReadLine()
    if ($null -eq $line) { throw "SMTP connection closed while reading reply." }
    $lines.Add($line) | Out-Null
    if ($line.Length -lt 4 -or $line[3] -ne '-') { break }
  }
  return ($lines -join "`n")
}

function Assert-SmtpCode {
  param([string]$Reply, [string[]]$Allowed)
  $code = if ($Reply.Length -ge 3) { $Reply.Substring(0, 3) } else { "" }
  if ($Allowed -notcontains $code) {
    throw "Unexpected SMTP reply code $code"
  }
}

function Connect-TcpClient {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMs = 10000
  )
  $client = [System.Net.Sockets.TcpClient]::new()
  $async = $client.BeginConnect($HostName, $Port, $null, $null)
  if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
    $client.Close()
    throw "TCP connect timed out to ${HostName}:${Port} after ${TimeoutMs}ms"
  }
  try {
    $client.EndConnect($async)
  } catch {
    $client.Close()
    throw
  } finally {
    $async.AsyncWaitHandle.Close()
  }
  $client.ReceiveTimeout = 15000
  $client.SendTimeout = 15000
  return $client
}

function Test-SmtpAuth {
  param([string]$HostName, [int]$Port, [string]$User, [string]$Password)
  $client = Connect-TcpClient -HostName $HostName -Port $Port
  try {
    $transport = $client.GetStream()
    if ($Port -eq 465) {
      $ssl = [System.Net.Security.SslStream]::new($transport, $false)
      $ssl.AuthenticateAsClient($HostName)
      $transport = $ssl
    }

    $reader = [System.IO.StreamReader]::new($transport, [System.Text.Encoding]::ASCII)
    $writer = [System.IO.StreamWriter]::new($transport, [System.Text.Encoding]::ASCII)
    $writer.NewLine = "`r`n"
    $writer.AutoFlush = $true
    Assert-SmtpCode (Read-SmtpReply $reader) @("220")
    $writer.WriteLine("EHLO localhost")
    Assert-SmtpCode (Read-SmtpReply $reader) @("250")
    if ($Port -ne 465) {
      $writer.WriteLine("STARTTLS")
      Assert-SmtpCode (Read-SmtpReply $reader) @("220")

      $ssl = [System.Net.Security.SslStream]::new($transport, $false)
      $ssl.AuthenticateAsClient($HostName)
      $reader = [System.IO.StreamReader]::new($ssl, [System.Text.Encoding]::ASCII)
      $writer = [System.IO.StreamWriter]::new($ssl, [System.Text.Encoding]::ASCII)
      $writer.NewLine = "`r`n"
      $writer.AutoFlush = $true
      $writer.WriteLine("EHLO localhost")
      Assert-SmtpCode (Read-SmtpReply $reader) @("250")
    }
    $authBytes = [System.Text.Encoding]::ASCII.GetBytes("`0$User`0$Password")
    $auth = [Convert]::ToBase64String($authBytes)
    $writer.WriteLine("AUTH PLAIN $auth")
    Assert-SmtpCode (Read-SmtpReply $reader) @("235")
    $writer.WriteLine("QUIT")
  } finally {
    $client.Close()
  }
}

function Quote-ImapString {
  param([string]$Value)
  return '"' + (($Value -replace '\\', '\\') -replace '"', '\"') + '"'
}

function Test-ImapAuth {
  param([string]$HostName, [int]$Port, [string]$User, [string]$Password)
  $client = Connect-TcpClient -HostName $HostName -Port $Port
  try {
    $ssl = [System.Net.Security.SslStream]::new($client.GetStream(), $false)
    $ssl.AuthenticateAsClient($HostName)
    $reader = [System.IO.StreamReader]::new($ssl, [System.Text.Encoding]::ASCII)
    $writer = [System.IO.StreamWriter]::new($ssl, [System.Text.Encoding]::ASCII)
    $writer.NewLine = "`r`n"
    $writer.AutoFlush = $true
    $banner = $reader.ReadLine()
    if ($banner -notmatch '^\* OK') { throw "Unexpected IMAP banner." }
    $writer.WriteLine("a001 LOGIN $(Quote-ImapString $User) $(Quote-ImapString $Password)")
    $reply = ""
    while ($true) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { throw "IMAP connection closed while logging in." }
      $reply += $line + "`n"
      if ($line -match '^a001 ') { break }
    }
    if ($reply -notmatch '(?m)^a001 OK') { throw "IMAP LOGIN did not return OK." }
    $writer.WriteLine("a002 LOGOUT")
  } finally {
    $client.Close()
  }
}

try {
  Write-Host "== Email auth smoke test =="
  Write-Host "email_sent=false"

  $envMap = Get-EnvMap $EnvPath
  if ($envMap.EMAIL_OUTREACH_ENABLED -ne "true") {
    if ($RequireEnabled) { throw "EMAIL_OUTREACH_ENABLED is not true." }
    Write-Host "[OK] Email auth=skipped reason=outreach_disabled"
    exit 0
  }

  Assert-Present $envMap @("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD", "EMAIL_FROM_ADDRESS")
  $smtpPort = [int]$envMap.SMTP_PORT
  $imapPort = if ([string]::IsNullOrWhiteSpace($envMap.IMAP_PORT)) { 993 } else { [int]$envMap.IMAP_PORT }
  Test-SmtpAuth -HostName $envMap.SMTP_HOST -Port $smtpPort -User $envMap.SMTP_USER -Password $envMap.SMTP_PASSWORD
  Write-Host "[OK] SMTP auth=accepted"
  Test-ImapAuth -HostName $envMap.IMAP_HOST -Port $imapPort -User $envMap.IMAP_USER -Password $envMap.IMAP_PASSWORD
  Write-Host "[OK] IMAP auth=accepted"
  Write-Host "[OK] Email auth smoke=passed email_sent=false"
} catch {
  Write-Error (Protect-Detail $_.Exception.Message) -ErrorAction Continue
  exit 1
}
