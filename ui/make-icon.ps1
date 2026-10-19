# make-icon.ps1 — 生成 ui\guardian.ico（多尺寸，全部使用经典 BMP 帧，兼容 .NET/WinForms）
# 零第三方依赖，仅用 System.Drawing。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$OutPath = Join-Path $PSScriptRoot 'guardian.ico'
$Sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

function New-RoundedPath([single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($w - $d, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $p.AddArc(0, $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [single]($size * 0.04)
  $inner = [single]($size - ($pad * 2))
  $path = New-RoundedPath $inner $inner ([single]($inner * 0.24))
  $mtx = New-Object System.Drawing.Drawing2D.Matrix
  $mtx.Translate($pad, $pad)
  $path.Transform($mtx)

  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, 0)),
    (New-Object System.Drawing.PointF($size, $size)),
    [System.Drawing.Color]::FromArgb(255, 20, 27, 42),
    [System.Drawing.Color]::FromArgb(255, 8, 11, 18)
  )
  $g.FillPath($bg, $path)

  $penW = [single]([math]::Max(1.0, $size * 0.055))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 78, 161, 255), $penW)
  $g.DrawPath($pen, $path)

  $font = New-Object System.Drawing.Font('Segoe UI', [single]($size * 0.54), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, [single](-$size * 0.02), $size, $size)
  $g.DrawString('G', $font, [System.Drawing.Brushes]::White, $rect, $sf)

  $font.Dispose()
  $pen.Dispose()
  $bg.Dispose()
  $path.Dispose()
  $g.Dispose()
  return $bmp
}

function Get-BmpFrameBytes([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $raw = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
  $bmp.UnlockBits($data)

  $xor = New-Object byte[] ($w * $h * 4)
  for ($y = 0; $y -lt $h; $y++) {
    $srcOff = ($h - 1 - $y) * $stride
    [Array]::Copy($raw, $srcOff, $xor, $y * $w * 4, $w * 4)
  }

  $maskStride = [int]([math]::Ceiling($w / 32.0) * 4)
  $mask = New-Object byte[] ($maskStride * $h)
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $alpha = $xor[(($y * $w) + $x) * 4 + 3]
      if ($alpha -eq 0) {
        $idx = ($y * $maskStride) + [int][math]::Floor($x / 8)
        $mask[$idx] = $mask[$idx] -bor ([byte](0x80 -shr ($x % 8)))
      }
    }
  }

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40)
  $bw.Write([int32]$w)
  $bw.Write([int32]($h * 2))
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]0)
  $bw.Write([uint32]($w * $h * 4))
  $bw.Write([int32]0)
  $bw.Write([int32]0)
  $bw.Write([uint32]0)
  $bw.Write([uint32]0)
  $bw.Write($xor)
  $bw.Write($mask)
  $bw.Flush()
  $bytes = $ms.ToArray()
  $bw.Dispose()
  $ms.Dispose()
  # 逗号包裹，避免 PowerShell 把 byte[] 展开成 object[] 后写不进 BinaryWriter
  return ,$bytes
}

$frames = @()
foreach ($s in $Sizes) {
  $bmp = New-IconBitmap $s
  $frames += [pscustomobject]@{ Size = $s; Data = (Get-BmpFrameBytes $bmp) }
  $bmp.Dispose()
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$frames.Count)

$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
  $dim = $f.Size
  if ($dim -ge 256) { $dim = 0 }
  $bw.Write([byte]$dim)
  $bw.Write([byte]$dim)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$f.Data.Length)
  $bw.Write([uint32]$offset)
  $offset += $f.Data.Length
}
foreach ($f in $frames) { $bw.Write([byte[]]$f.Data) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($OutPath, $ms.ToArray())
$bw.Dispose()
$ms.Dispose()

Write-Host ('图标已生成: {0} ({1:N0} 字节, {2} 个尺寸)' -f $OutPath, (Get-Item $OutPath).Length, $frames.Count)
