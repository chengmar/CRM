param(
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path (Split-Path -Parent $PSScriptRoot) "build"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

function New-RoundedPath {
  param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-BrandBitmap {
  param([int]$Size)
  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $margin = [float]($Size * 0.055)
  $radius = [float]($Size * 0.19)
  $path = New-RoundedPath $margin $margin ($Size - 2 * $margin) ($Size - 2 * $margin) $radius
  $background = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 21, 158, 140))
  $graphics.FillPath($background, $path)

  $innerMargin = [float]($Size * 0.145)
  $innerRadius = [float]($Size * 0.13)
  $inner = New-RoundedPath $innerMargin $innerMargin ($Size - 2 * $innerMargin) ($Size - 2 * $innerMargin) $innerRadius
  $panel = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 22, 34, 45))
  $graphics.FillPath($panel, $inner)

  $fontSize = [float]($Size * 0.31)
  $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString("CRM", $font, $brush, (New-Object System.Drawing.RectangleF(0, 0, $Size, $Size * 0.91)), $format)

  $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 129, 222, 200))
  $dot = [float]($Size * 0.035)
  foreach ($offset in @(-0.10, 0, 0.10)) {
    $graphics.FillEllipse($accent, [float]($Size * (0.5 + $offset) - $dot / 2), [float]($Size * 0.72), $dot, $dot)
  }

  $accent.Dispose()
  $format.Dispose()
  $brush.Dispose()
  $font.Dispose()
  $panel.Dispose()
  $inner.Dispose()
  $background.Dispose()
  $path.Dispose()
  $graphics.Dispose()
  return $bitmap
}

$pngPath = Join-Path $OutputDir "icon.png"
$master = New-BrandBitmap 1024
$master.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$master.Dispose()

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = New-Object System.Collections.Generic.List[byte[]]
foreach ($size in $sizes) {
  $bitmap = New-BrandBitmap $size
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames.Add($stream.ToArray())
  $stream.Dispose()
  $bitmap.Dispose()
}

$icoPath = Join-Path $OutputDir "icon.ico"
$file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($file)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$frames.Count)
  $offset = 6 + (16 * $frames.Count)
  for ($index = 0; $index -lt $frames.Count; $index++) {
    $size = $sizes[$index]
    $encodedSize = if ($size -eq 256) { 0 } else { $size }
    $writer.Write([byte]$encodedSize)
    $writer.Write([byte]$encodedSize)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$frames[$index].Length)
    $writer.Write([uint32]$offset)
    $offset += $frames[$index].Length
  }
  foreach ($frame in $frames) { $writer.Write($frame) }
} finally {
  $writer.Dispose()
  $file.Dispose()
}

Write-Host "[OK] Brand PNG: $pngPath"
Write-Host "[OK] Brand ICO: $icoPath"
