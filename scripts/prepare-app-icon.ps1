param(
    [string]$Source = (Join-Path $PSScriptRoot "..\branding\threadfleet-icon.png"),
    [string]$AppIconOutput = (Join-Path $PSScriptRoot "..\branding\threadfleet-icon-rounded.png"),
    [string]$TrayIconOutput = (Join-Path $PSScriptRoot "..\src-tauri\icons\tray-icon-template.png")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath([float]$size, [float]$radius) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $radius * 2
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($size - $diameter, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($size - $diameter, $size - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $size - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

$sourcePath = (Resolve-Path $Source).Path
$sourceBitmap = [System.Drawing.Bitmap]::new($sourcePath)

try {
    if ($sourceBitmap.Width -ne 2048 -or $sourceBitmap.Height -ne 2048) {
        throw "The ThreadFleet icon source must remain 2048x2048; update the tray crop before changing its dimensions."
    }

    $appSize = 1024
    $appBitmap = [System.Drawing.Bitmap]::new($appSize, $appSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $appGraphics = [System.Drawing.Graphics]::FromImage($appBitmap)
    $appPath = New-RoundedRectanglePath $appSize 224

    try {
        $appGraphics.Clear([System.Drawing.Color]::Transparent)
        $appGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $appGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $appGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $appGraphics.SetClip($appPath)
        $appGraphics.DrawImage($sourceBitmap, [System.Drawing.Rectangle]::new(0, 0, $appSize, $appSize))
        $appBitmap.Save($AppIconOutput, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $appPath.Dispose()
        $appGraphics.Dispose()
        $appBitmap.Dispose()
    }

    $trayCrop = [System.Drawing.Rectangle]::new(260, 180, 1400, 1350)
    $maskBitmap = [System.Drawing.Bitmap]::new($trayCrop.Width, $trayCrop.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $trayBitmap = [System.Drawing.Bitmap]::new(44, 44, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $trayGraphics = [System.Drawing.Graphics]::FromImage($trayBitmap)

    try {
        for ($y = 0; $y -lt $trayCrop.Height; $y++) {
            for ($x = 0; $x -lt $trayCrop.Width; $x++) {
                $pixel = $sourceBitmap.GetPixel($trayCrop.X + $x, $trayCrop.Y + $y)
                if ($pixel.R -lt 64 -and $pixel.G -lt 64 -and $pixel.B -lt 64) {
                    $maskBitmap.SetPixel($x, $y, [System.Drawing.Color]::Black)
                }
            }
        }

        $trayGraphics.Clear([System.Drawing.Color]::Transparent)
        $trayGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $trayGraphics.DrawImage($maskBitmap, [System.Drawing.Rectangle]::new(0, 0, 44, 44))
        $trayBitmap.Save($TrayIconOutput, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $trayGraphics.Dispose()
        $trayBitmap.Dispose()
        $maskBitmap.Dispose()
    }
}
finally {
    $sourceBitmap.Dispose()
}
