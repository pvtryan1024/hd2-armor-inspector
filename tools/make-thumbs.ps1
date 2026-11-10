# Shrinks downloaded wiki images into small PNG thumbnails named after enemy/weapon ids.
#   Enemies: powershell -File tools/make-thumbs.ps1 -Src <folder> -Out images/enemies -Width 72 -Height 72
#   Weapons: powershell -File tools/make-thumbs.ps1 -Src <folder> -Out images/weapons -Width 128 -Height 64
# <folder> holds the originals plus map.json ({ "file.png": ["id", ...] }). SVG icons are copied as-is.
param(
  [Parameter(Mandatory)] [string]$Src,
  [string]$Out = 'images/enemies',
  [int]$Width = 72,
  [int]$Height = 72
)
Add-Type -AssemblyName System.Drawing
$outDir = Join-Path (Join-Path $PSScriptRoot '..') $Out
New-Item -ItemType Directory -Force $outDir | Out-Null
$map = Get-Content (Join-Path $Src 'map.json') -Raw | ConvertFrom-Json
foreach ($p in $map.PSObject.Properties) {
  $file = Join-Path $Src $p.Name
  if ($p.Name -like '*.svg') {
    foreach ($id in $p.Value) { Copy-Item $file (Join-Path $outDir "$id.svg") -Force }
    continue
  }
  $img = [System.Drawing.Image]::FromFile($file)
  try {
    # fit inside the box, keep aspect ratio, transparent padding
    $scale = [Math]::Min($Width / $img.Width, $Height / $img.Height)
    $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)
    $bmp = New-Object System.Drawing.Bitmap $Width, $Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
    $g.DrawImage($img, [int](($Width - $w) / 2), [int](($Height - $h) / 2), $w, $h)
    foreach ($id in $p.Value) { $bmp.Save((Join-Path $outDir "$id.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
    $g.Dispose(); $bmp.Dispose()
  } finally { $img.Dispose() }
}
Write-Output "thumbnails in ${Out}: $((Get-ChildItem $outDir -File).Count)"
