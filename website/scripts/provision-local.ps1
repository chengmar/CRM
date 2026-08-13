[CmdletBinding()]
param(
	[switch] $IncludeMigrationMedia
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Native command failures are checked explicitly so expected WP-CLI probe failures
# can be handled consistently in both Windows PowerShell 5.1 and PowerShell 7.
if ( Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue ) {
	$PSNativeCommandUseErrorActionPreference = $false
}

$scriptDirectory = Split-Path -Parent $PSCommandPath
$projectRoot     = [System.IO.Path]::GetFullPath( ( Join-Path $scriptDirectory '..' ) )
$envPath         = Join-Path $projectRoot '.env'
$composePath     = Join-Path $projectRoot 'compose.yaml'

function Read-DotEnvFile {
	param(
		[Parameter( Mandatory = $true )]
		[string] $Path
	)

	$values = @{}
	foreach ( $rawLine in [System.IO.File]::ReadAllLines( $Path ) ) {
		$line = $rawLine.Trim()
		if ( [string]::IsNullOrWhiteSpace( $line ) -or $line.StartsWith( '#' ) ) {
			continue
		}

		$separatorIndex = $line.IndexOf( '=' )
		if ( $separatorIndex -lt 1 ) {
			throw "Invalid .env entry. Expected KEY=VALUE."
		}

		$key   = $line.Substring( 0, $separatorIndex ).Trim().TrimStart( [char] 0xFEFF )
		$value = $line.Substring( $separatorIndex + 1 ).Trim()
		if ( $key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' ) {
			throw "Invalid .env key: $key"
		}

		if ( $value.Length -ge 2 ) {
			$firstCharacter = $value.Substring( 0, 1 )
			$lastCharacter  = $value.Substring( $value.Length - 1, 1 )
			if ( ( $firstCharacter -eq '"' -and $lastCharacter -eq '"' ) -or
				( $firstCharacter -eq "'" -and $lastCharacter -eq "'" ) ) {
				$value = $value.Substring( 1, $value.Length - 2 )
			}
		}

		$values[$key] = $value
	}

	return $values
}

function Get-LocalSetting {
	param(
		[Parameter( Mandatory = $true )]
		[hashtable] $Settings,

		[Parameter( Mandatory = $true )]
		[string] $Name,

		[string] $DefaultValue = ''
	)

	if ( $Settings.ContainsKey( $Name ) -and
		-not [string]::IsNullOrWhiteSpace( [string] $Settings[$Name] ) ) {
		return [string] $Settings[$Name]
	}

	return $DefaultValue
}

function Get-RequiredInstallSetting {
	param(
		[Parameter( Mandatory = $true )]
		[hashtable] $Settings,

		[Parameter( Mandatory = $true )]
		[string] $Name
	)

	$value = Get-LocalSetting -Settings $Settings -Name $Name
	if ( [string]::IsNullOrWhiteSpace( $value ) -or $value.StartsWith( 'replace-with-' ) ) {
		throw "A new WordPress database requires a non-placeholder $Name value in .env."
	}

	return $value
}

function Assert-LoopbackUrl {
	param(
		[Parameter( Mandatory = $true )]
		[string] $Url,

		[int] $ExpectedPort = 0
	)

	try {
		$uri = [System.Uri] $Url
	} catch {
		throw 'WORDPRESS_URL must be an absolute http:// or https:// URL.'
	}

	if ( -not $uri.IsAbsoluteUri -or $uri.Scheme -notin @( 'http', 'https' ) ) {
		throw 'WORDPRESS_URL must be an absolute http:// or https:// URL.'
	}

	$hostName   = $uri.Host.Trim( [char[]] '[]' )
	$isLoopback = $hostName -eq 'localhost'
	$ipAddress  = $null
	if ( [System.Net.IPAddress]::TryParse( $hostName, [ref] $ipAddress ) ) {
		$isLoopback = [System.Net.IPAddress]::IsLoopback( $ipAddress )
	}

	if ( -not $isLoopback ) {
		throw 'Local provisioning is restricted to localhost or a loopback IP address.'
	}

	if ( $ExpectedPort -gt 0 -and $uri.Port -ne $ExpectedPort ) {
		throw "WORDPRESS_URL port must match WORDPRESS_PORT ($ExpectedPort)."
	}
}

function Invoke-Compose {
	param(
		[Parameter( Mandatory = $true )]
		[string[]] $Arguments,

		[int[]] $AllowedExitCodes = @( 0 ),

		[switch] $CaptureOutput
	)

	$dockerArguments = @(
		'compose',
		'--env-file', $envPath,
		'-f', $composePath
	) + $Arguments

	if ( $CaptureOutput ) {
		# Windows PowerShell 5.1 wraps normal Docker progress on stderr as a
		# NativeCommandError when stderr is redirected. The process exit code is
		# the authoritative result for these quiet probe calls.
		$previousErrorActionPreference = $ErrorActionPreference
		try {
			$ErrorActionPreference = 'Continue'
			$output   = @( & docker @dockerArguments 2>$null )
			$exitCode = $LASTEXITCODE
		} finally {
			$ErrorActionPreference = $previousErrorActionPreference
		}
		if ( $AllowedExitCodes -notcontains $exitCode ) {
			throw "Docker Compose command failed with exit code $exitCode."
		}

		return [PSCustomObject] @{
			ExitCode = $exitCode
			Output   = $output
		}
	}

	& docker @dockerArguments
	$exitCode = $LASTEXITCODE
	if ( $AllowedExitCodes -notcontains $exitCode ) {
		throw "Docker Compose command failed with exit code $exitCode."
	}
}

function Invoke-WpCli {
	param(
		[Parameter( Mandatory = $true )]
		[string[]] $Arguments
	)

	Invoke-Compose -Arguments ( @( 'run', '--rm', '--no-deps', 'wpcli', 'wp' ) + $Arguments )
}

function Invoke-WpCliCapture {
	param(
		[Parameter( Mandatory = $true )]
		[string[]] $Arguments,

		[int[]] $AllowedExitCodes = @( 0 )
	)

	return Invoke-Compose `
		-Arguments ( @( 'run', '--rm', '--no-deps', 'wpcli', 'wp' ) + $Arguments ) `
		-AllowedExitCodes $AllowedExitCodes `
		-CaptureOutput
}

function Get-CapturedText {
	param(
		[Parameter( Mandatory = $true )]
		[PSCustomObject] $Result
	)

	return ( ( $Result.Output | ForEach-Object { [string] $_ } ) -join "`n" ).Trim()
}

function Install-PinnedPlugin {
	param(
		[Parameter( Mandatory = $true )]
		[string] $Slug,

		[Parameter( Mandatory = $true )]
		[string] $Version
	)

	$versionProbe = Invoke-WpCliCapture `
		-Arguments @( 'plugin', 'get', $Slug, '--field=version' ) `
		-AllowedExitCodes @( 0, 1 )
	$installedVersion = if ( $versionProbe.ExitCode -eq 0 ) {
		Get-CapturedText -Result $versionProbe
	} else {
		''
	}

	if ( $installedVersion -ne $Version ) {
		Write-Host "Installing $Slug $Version..."
		Invoke-WpCli -Arguments @( 'plugin', 'install', $Slug, "--version=$Version", '--force' )
	}

	Invoke-WpCli -Arguments @( 'plugin', 'activate', $Slug, '--quiet' )

	$verification = Invoke-WpCliCapture -Arguments @( 'plugin', 'get', $Slug, '--field=version' )
	if ( ( Get-CapturedText -Result $verification ) -ne $Version ) {
		throw "Plugin version verification failed for $Slug."
	}
}

if ( -not ( Test-Path -LiteralPath $envPath -PathType Leaf ) ) {
	throw 'Missing .env. Create it from .env.example and set local-only credentials first.'
}
if ( -not ( Test-Path -LiteralPath $composePath -PathType Leaf ) ) {
	throw 'Missing compose.yaml.'
}

$null = Get-Command docker -ErrorAction Stop
$settings = Read-DotEnvFile -Path $envPath
$portText = Get-LocalSetting -Settings $settings -Name 'WORDPRESS_PORT' -DefaultValue '8088'
$port     = 0
if ( -not [int]::TryParse( $portText, [ref] $port ) -or $port -lt 1 -or $port -gt 65535 ) {
	throw 'WORDPRESS_PORT in .env must be an integer from 1 to 65535.'
}

Push-Location $projectRoot
try {
	Write-Host 'Starting the isolated local WordPress stack...'
	Invoke-Compose -Arguments @( 'up', '-d', '--wait' )

	$wordpressReady = $false
	for ( $attempt = 1; $attempt -le 20; $attempt++ ) {
		$readyProbe = Invoke-WpCliCapture `
			-Arguments @( 'core', 'version' ) `
			-AllowedExitCodes @( 0, 1 )
		if ( $readyProbe.ExitCode -eq 0 ) {
			$wordpressReady = $true
			break
		}

		if ( $attempt -lt 20 ) {
			Start-Sleep -Seconds 2
		}
	}

	if ( -not $wordpressReady ) {
		throw 'WordPress files did not become ready within 40 seconds.'
	}

	$installProbe = Invoke-WpCliCapture `
		-Arguments @( 'core', 'is-installed' ) `
		-AllowedExitCodes @( 0, 1 )
	if ( $installProbe.ExitCode -ne 0 ) {
		$siteUrl = Get-LocalSetting `
			-Settings $settings `
			-Name 'WORDPRESS_URL' `
			-DefaultValue "http://127.0.0.1:$port"
		Assert-LoopbackUrl -Url $siteUrl -ExpectedPort $port

		$siteTitle     = Get-RequiredInstallSetting -Settings $settings -Name 'WORDPRESS_TITLE'
		$adminUser     = Get-RequiredInstallSetting -Settings $settings -Name 'WORDPRESS_ADMIN_USER'
		$adminPassword = Get-RequiredInstallSetting -Settings $settings -Name 'WORDPRESS_ADMIN_PASSWORD'
		$adminEmail    = Get-RequiredInstallSetting -Settings $settings -Name 'WORDPRESS_ADMIN_EMAIL'

		Write-Host 'Installing WordPress in the local database...'
		$installArguments = @(
			'compose',
			'--env-file', $envPath,
			'-f', $composePath,
			'run', '--rm', '--no-deps', '-T',
			'wpcli', 'wp', 'core', 'install',
			"--url=$siteUrl",
			"--title=$siteTitle",
			"--admin_user=$adminUser",
			"--admin_email=$adminEmail",
			'--skip-email',
			'--prompt=admin_password'
		)
		$adminPassword | & docker @installArguments
		$installExitCode = $LASTEXITCODE
		Remove-Variable -Name adminPassword
		if ( $installExitCode -ne 0 ) {
			throw "WordPress installation failed with exit code $installExitCode."
		}
	}

	$environmentProbe = Invoke-WpCliCapture -Arguments @( 'eval', 'echo wp_get_environment_type();' )
	if ( ( Get-CapturedText -Result $environmentProbe ) -ne 'local' ) {
		throw 'Provisioning stopped because WordPress is not running in the local environment.'
	}

	$databaseUrlProbe = Invoke-WpCliCapture -Arguments @( 'option', 'get', 'siteurl' )
	Assert-LoopbackUrl -Url ( Get-CapturedText -Result $databaseUrlProbe ) -ExpectedPort $port

	$pinnedPlugins = [ordered] @{
		'seo-by-rank-math' = '1.0.274.1'
		'fluentform'        = '6.2.8'
		'wp-mail-smtp'      = '4.9.0'
		'updraftplus'       = '1.26.5'
	}
	foreach ( $plugin in $pinnedPlugins.GetEnumerator() ) {
		Install-PinnedPlugin -Slug $plugin.Key -Version $plugin.Value
	}

	Invoke-WpCli -Arguments @( 'plugin', 'activate', 'demo_manufacturer-core', '--quiet' )
	Invoke-WpCli -Arguments @( 'theme', 'activate', 'demo_manufacturer', '--quiet' )

	$bootstrapArguments = @( 'eval-file', '/opt/demo_manufacturer-tools/bootstrap-local.php' )
	if ( $IncludeMigrationMedia ) {
		$bootstrapArguments += 'include-migration-media'
	}
	Invoke-WpCli -Arguments $bootstrapArguments
	Invoke-WpCli -Arguments @( 'rewrite', 'flush' )

	$localUrl = Get-CapturedText -Result (
		Invoke-WpCliCapture -Arguments @( 'option', 'get', 'home' )
	)
	Write-Host "Local Demo Manufacturer site is ready at $localUrl"
} finally {
	Pop-Location
}
