[CmdletBinding()]
param(
    [switch]$Studio,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
    @"
Install the native web version of UIT Studio on Windows.

Usage:
  .\install.ps1 -Studio
  .\install.ps1 -Help

Environment:
  UIT_INSTALL_VERSION        Release tag to install, for example v2.0.0
  UIT_INSTALL_REPOSITORY     GitHub repository, default RyanNg1403/uit-cli
  UIT_INSTALL_BASE_URL       Override the release asset base URL (useful for tests)
  UIT_INSTALL_STUDIO_DIR     Install directory, default %LOCALAPPDATA%\UIT\Studio
  UIT_INSTALL_BIN_DIR        Launcher directory, default the install directory's bin
"@
}

if ($Help) {
    Show-Usage
    exit 0
}

if (-not $Studio) {
    Show-Usage
    throw "Specify -Studio to install UIT Studio."
}

function Get-ReleaseBaseUrl {
    $repository = if ($env:UIT_INSTALL_REPOSITORY) { $env:UIT_INSTALL_REPOSITORY } else { "RyanNg1403/uit-cli" }
    $release = if ($env:UIT_INSTALL_VERSION) { $env:UIT_INSTALL_VERSION } else { "latest" }
    if ($env:UIT_INSTALL_BASE_URL) {
        return $env:UIT_INSTALL_BASE_URL.TrimEnd("/")
    }
    if ($release -eq "latest") {
        return "https://github.com/$repository/releases/latest/download"
    }
    if ($release -notmatch '^v\d+\.\d+\.\d+$') {
        throw "UIT_INSTALL_VERSION must be a release tag such as v2.0.0."
    }
    return "https://github.com/$repository/releases/download/$release"
}

function Get-ReleaseFile([string]$Uri, [string]$Destination) {
    if ($Uri.StartsWith("file://", [System.StringComparison]::OrdinalIgnoreCase)) {
        $source = ([System.Uri]$Uri).LocalPath
        Copy-Item -LiteralPath $source -Destination $Destination -Force
        return
    }
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
}

function Add-UserPath([string]$Directory) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = if ($current) { @($current -split ';' | Where-Object { $_ }) } else { @() }
    if ($entries | Where-Object { $_.TrimEnd('\') -ieq $Directory.TrimEnd('\') }) {
        return
    }
    $updated = if ($current) { "$current;$Directory" } else { $Directory }
    [Environment]::SetEnvironmentVariable("Path", $updated, "User")
    Write-Host "Added $Directory to the user PATH. Open a new terminal before running uit-studio."
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($architecture -ne "X64") {
    throw "Unsupported Windows architecture: $architecture. UIT Studio native Windows releases currently support x64."
}

$asset = "UIT-Studio-web-windows-x64.zip"
$baseUrl = Get-ReleaseBaseUrl
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("uit-studio-install-" + [guid]::NewGuid().ToString("N"))
$installRoot = if ($env:UIT_INSTALL_STUDIO_DIR) { $env:UIT_INSTALL_STUDIO_DIR } else { Join-Path $env:LOCALAPPDATA "UIT\Studio" }
$binaryDirectory = if ($env:UIT_INSTALL_BIN_DIR) { $env:UIT_INSTALL_BIN_DIR } else { Join-Path $installRoot "bin" }
$targetDirectory = $installRoot
$customBinaryDirectory = ([System.IO.Path]::GetFullPath($binaryDirectory).TrimEnd('\') -ine [System.IO.Path]::GetFullPath((Join-Path $targetDirectory "bin")).TrimEnd('\'))
$temporaryLauncher = $null
$replacementDirectory = $null
$backupDirectory = $null
$replacementStarted = $false

try {
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
    $archivePath = Join-Path $temporaryDirectory $asset
    $checksumPath = "$archivePath.sha256"
    Write-Host "Downloading UIT Studio for Windows (x64)..."
    Get-ReleaseFile "$baseUrl/$asset" $archivePath
    Get-ReleaseFile "$baseUrl/$asset.sha256" $checksumPath

    $expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$') {
        throw "The downloaded UIT Studio checksum file is invalid."
    }
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "The downloaded UIT Studio archive failed checksum verification."
    }

    $replacementDirectory = Join-Path (Split-Path -Parent $targetDirectory) (".uit-studio-install-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $replacementDirectory -Force | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $replacementDirectory -Force
    $sourceDirectory = Join-Path $replacementDirectory "uit-studio"
    $sourceLauncher = Join-Path $sourceDirectory "bin\uit-studio.cmd"
    $sourceNode = Join-Path $sourceDirectory "bin\node.exe"
    if (-not (Test-Path -LiteralPath $sourceLauncher -PathType Leaf)) {
        throw "The release archive does not contain the native UIT Studio launcher."
    }
    if (-not (Test-Path -LiteralPath $sourceNode -PathType Leaf)) {
        throw "The release archive does not contain the bundled Node.js runtime."
    }

    $targetParent = Split-Path -Parent $targetDirectory
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    $backupDirectory = Join-Path $replacementDirectory "previous"
    if (Test-Path -LiteralPath $targetDirectory) {
        $replacementStarted = $true
        Move-Item -LiteralPath $targetDirectory -Destination $backupDirectory
    }
    Move-Item -LiteralPath $sourceDirectory -Destination $targetDirectory
    $replacementStarted = $true

    $targetLauncher = Join-Path $targetDirectory "bin\uit-studio.cmd"
    if ($customBinaryDirectory) {
        New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
        $customLauncher = Join-Path $binaryDirectory "uit-studio.cmd"
        if (Test-Path -LiteralPath $customLauncher) {
            $existingLauncher = Get-Content -LiteralPath $customLauncher -Raw
            if ($existingLauncher -notmatch 'UIT_STUDIO_NATIVE') {
                throw "$customLauncher already exists and is not managed by the UIT installer."
            }
        }
        $temporaryLauncher = Join-Path $binaryDirectory (".uit-studio-launcher-" + [guid]::NewGuid().ToString("N") + ".cmd")
        @"
@echo off
setlocal
set "UIT_STUDIO_NATIVE=1"
"$targetLauncher" %*
exit /b %ERRORLEVEL%
"@ | Set-Content -LiteralPath $temporaryLauncher -Encoding ASCII
        Move-Item -LiteralPath $temporaryLauncher -Destination $customLauncher -Force
        $temporaryLauncher = $null
    }

    Add-UserPath $binaryDirectory
    $replacementStarted = $false
    Remove-Item -LiteralPath $replacementDirectory -Recurse -Force
    $replacementDirectory = $null
    Write-Host ""
    Write-Host "UIT Studio was installed at $targetLauncher"
    Write-Host "Run uit-studio from a new terminal to open the local web Studio."
}
catch {
    if ($replacementStarted) {
        Remove-Item -LiteralPath $targetDirectory -Recurse -Force -ErrorAction SilentlyContinue
        if ($backupDirectory -and (Test-Path -LiteralPath $backupDirectory)) {
            Move-Item -LiteralPath $backupDirectory -Destination $targetDirectory -Force -ErrorAction SilentlyContinue
        }
    }
    throw
}
finally {
    if ($temporaryLauncher) { Remove-Item -LiteralPath $temporaryLauncher -Force -ErrorAction SilentlyContinue }
    if ($replacementDirectory) { Remove-Item -LiteralPath $replacementDirectory -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
