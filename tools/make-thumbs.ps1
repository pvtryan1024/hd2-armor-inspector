# Shrinks downloaded enemy icons into 72x72 PNG thumbnails at images/enemies/<enemy-id>.png.
# Usage: powershell -File tools/make-thumbs.ps1 <folder with originals + map.json>
param([Parameter(Mandatory)] [string]$Src)
Add-Type -AssemblyName System.Drawing
$size = 72
$out = Join-Path $PSScriptRoot '..\images\enemies'
New-Item -ItemType Directory -Force $out | Out-Null
$map = Get-Content (Join-Path $Src 'map.json') -Raw | ConvertFrom-Json
foreach ($p in $map.PSObject.Properties) {
  $img = [System.Drawing.Image]::FromFile((Join-Path $Src $p.Name))
  try {
    # fit inside the square, keep aspect ratio, transparent padding
    $scale = [Math]::Min($size / $img.Width, $size / $img.Height)
    $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
    $g.DrawImage($img, [int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
    foreach ($id in $p.Value) { $bmp.Save((Join-Path $out "$id.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
    $g.Dispose(); $bmp.Dispose()
  } finally { $img.Dispose() }
}
Write-Output "thumbnails: $((Get-ChildItem $out -Filter *.png).Count)"
