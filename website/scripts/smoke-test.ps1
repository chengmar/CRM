param(
    [string]$BaseUrl = 'http://127.0.0.1:8088'
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
$failures = [System.Collections.Generic.List[string]]::new()

function Invoke-DemoManufacturerRequest {
    param([Parameter(Mandatory = $true)][string]$Uri)

    try {
        return Invoke-WebRequest -Uri $Uri -UseBasicParsing
    }
    catch {
        $errorResponse = $_.Exception.Response
        if ($null -eq $errorResponse) {
            throw
        }

        $stream = $errorResponse.GetResponseStream()
        $reader = [IO.StreamReader]::new($stream)
        try {
            return [pscustomobject]@{
                StatusCode = [int]$errorResponse.StatusCode
                Content = $reader.ReadToEnd()
            }
        }
        finally {
            $reader.Dispose()
            $stream.Dispose()
            $errorResponse.Dispose()
        }
    }
}

$routes = [ordered]@{
    '/' = 200
    '/about/' = 200
    '/products/' = 200
    '/accessories/' = 200
    '/industries/' = 200
    '/cases/' = 200
    '/blog/' = 200
    '/downloads/' = 200
    '/contact/' = 200
    '/privacy-policy/' = 200
}

$forbidden = @(
    'legacy.example',
    'supplier@example.com',
    '0015550100000',
    '15550100000'
)

foreach ($route in $routes.GetEnumerator()) {
    $response = Invoke-DemoManufacturerRequest -Uri ($base + $route.Key)
    $status = [int]$response.StatusCode
    if ($status -ne $route.Value) {
        $failures.Add("$($route.Key): expected $($route.Value), received $status")
    }

    $decoded = [Net.WebUtility]::HtmlDecode([string]$response.Content)
    if (
        $decoded.IndexOf('WordPress database error:', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $decoded.IndexOf('class="wpdberror"', [StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
        $failures.Add("$($route.Key): contains a WordPress database error")
    }

    foreach ($value in $forbidden) {
        if ($decoded.IndexOf($value, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $failures.Add("$($route.Key): contains forbidden identity value '$value'")
        }
    }

    if ($decoded.IndexOf('Demo Manufacturer', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        $failures.Add("$($route.Key): Demo Manufacturer brand is missing")
    }
    if ($decoded.IndexOf('sales@example.com', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        $failures.Add("$($route.Key): approved inquiry email is missing")
    }
    if ($decoded.IndexOf('15550100000', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        $failures.Add("$($route.Key): approved WhatsApp number is missing")
    }
}

$sitemapResponse = Invoke-DemoManufacturerRequest -Uri ($base + '/sitemap_index.xml')
$sitemap = [string]$sitemapResponse.Content
foreach ($requiredSitemap in @('post-sitemap.xml', 'page-sitemap.xml', 'demo_product-sitemap.xml')) {
    if ($sitemap.IndexOf($requiredSitemap, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        $failures.Add("sitemap_index.xml: missing '$requiredSitemap'")
    }
}
foreach ($excludedSitemap in @('author-sitemap.xml', 'category-sitemap.xml', 'demo_case_study-sitemap.xml')) {
    if ($sitemap.IndexOf($excludedSitemap, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $failures.Add("sitemap_index.xml: unexpectedly contains '$excludedSitemap'")
    }
}

$usersResponse = Invoke-DemoManufacturerRequest -Uri ($base + '/wp-json/wp/v2/users?per_page=100')
try {
    $publicUsers = @($usersResponse.Content | ConvertFrom-Json)
    $publicSlugs = @($publicUsers | ForEach-Object { [string]$_.slug })
    if ($publicSlugs -notcontains 'demo_manufacturer') {
        $failures.Add('users REST API: dedicated Demo Manufacturer content author is missing')
    }
    if ($publicSlugs -contains 'demo_manufacturer_local_admin') {
        $failures.Add('users REST API: local administrator slug is publicly exposed')
    }
}
catch {
    $failures.Add("users REST API: response is not valid JSON ($($_.Exception.Message))")
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "PASS: $($routes.Count) routes, approved identity, forbidden values, sitemap index, and public author verified."
