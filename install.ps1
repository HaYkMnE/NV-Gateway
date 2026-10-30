<#
  NV Gateway installer for Windows (per-user, no admin rights).

  What it does:
    1. Finds the release version (latest by default).
    2. Downloads NV-Gateway-Setup-<ver>.exe and SHA256SUMS.txt from
       https://github.com/HaYkMnE/NV-Gateway/releases into a new temp folder.
    3. Checks the installer's SHA256 against SHA256SUMS.txt. Stops on a mismatch.
    4. Runs the installer silently for the current user: /S /currentuser [/D=<dir>]
    5. Checks the install in the registry and deletes the temp folder.
  It does not request admin rights, change security settings, Defender settings
  or the execution policy, and it sends no telemetry.

  Source: https://github.com/HaYkMnE/NV-Gateway/blob/main/install.ps1

  Review before running:
    irm https://raw.githubusercontent.com/HaYkMnE/NV-Gateway/main/install.ps1 -OutFile install.ps1
    notepad install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Version 0.1.4] [-InstallDir "D:\Apps\NV-Gateway"] [-WhatIf]
    -ExecutionPolicy Bypass applies to this process only; `irm | iex` needs no flag.

  -WhatIf downloads and verifies the installer but does not run it.
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$InstallDir = '',
    [switch]$WhatIf
)

# Everything runs inside a child scope, so StrictMode and preference variables
# do not leak into your session when the script is piped to Invoke-Expression.
& { param($Version, $InstallDir, $WhatIf)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'NV Gateway installer runs on Windows only.' }
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without the progress bar on 5.1

# Windows PowerShell 5.1 may default to TLS 1.0; GitHub requires TLS 1.2.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$Repo      = 'HaYkMnE/NV-Gateway'
$RepoUrl   = "https://github.com/$Repo"
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\9987d4f1-2bc8-5c81-b43e-1d2d04b8b929'

# --- 1. Resolve the version ------------------------------------------------
if ($Version -eq 'latest') {
    try {
        $rel = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'nvgw-install' }
        $Version = [string]$rel.tag_name
    } catch {
        # API rate-limited or unreachable: read the redirect target of /releases/latest instead.
        Write-Host "GitHub API unavailable ($($_.Exception.Message)); using the releases/latest redirect."
        $req = [System.Net.HttpWebRequest]::Create("$RepoUrl/releases/latest")
        $req.AllowAutoRedirect = $false
        $req.UserAgent = 'nvgw-install'
        $resp = $req.GetResponse()
        try { $Version = ([string]$resp.Headers['Location']).TrimEnd('/').Split('/')[-1] } finally { $resp.Close() }
    }
}
$Version = $Version.TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$') { throw "Invalid version '$Version'. Expected something like 0.1.4." }

if ($InstallDir) {
    # NSIS takes /D=<dir> as the last argument, unquoted, so the path itself must not contain quotes.
    if ($InstallDir -match '"' -or -not [System.IO.Path]::IsPathRooted($InstallDir)) { throw "InstallDir must be an absolute path without quotes: $InstallDir" }
}

$ExeName = "NV-Gateway-Setup-$Version.exe"
$BaseUrl = "$RepoUrl/releases/download/v$Version"
$InstArgs = '/S /currentuser'
if ($InstallDir) { $InstArgs += " /D=$InstallDir" }

# --- 2. Show the plan -------------------------------------------------------
Write-Host "NV Gateway installer"
Write-Host "  Version     : $Version"
Write-Host "  Download    : $BaseUrl/$ExeName"
Write-Host "  Checksums   : $BaseUrl/SHA256SUMS.txt"
Write-Host "  Install dir : $(if ($InstallDir) { $InstallDir } else { 'installer default (per-user)' })"
Write-Host "  Command     : $ExeName $InstArgs"
if ($WhatIf) { Write-Host "  Mode        : -WhatIf (download and verify only, no install)" }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Write-Warning "This shell is elevated. Admin rights are not needed; the app installs for the current user." }

$Temp = Join-Path $env:TEMP ("nvgw-install-" + [System.IO.Path]::GetRandomFileName().Replace('.', ''))
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    # --- 3. Download ----------------------------------------------------------
    $exe  = Join-Path $Temp $ExeName
    $sums = Join-Path $Temp 'SHA256SUMS.txt'
    Write-Host "Downloading SHA256SUMS.txt ..."
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $sums
    Write-Host "Downloading $ExeName ..."
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$ExeName" -OutFile $exe

    # --- 4. Verify SHA256 (line format: "<sha256>  <filename>") ---------------
    $line = Get-Content -LiteralPath $sums | Where-Object { ($_ -split '\s+', 2)[-1].Trim().TrimStart('*') -eq $ExeName } | Select-Object -First 1
    if (-not $line) { throw "SHA256SUMS.txt has no entry for $ExeName." }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual   = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Remove-Item -LiteralPath $exe -Force
        throw "SHA256 mismatch for $ExeName (expected $expected, got $actual). The file was deleted and nothing was installed."
    }
    Write-Host "SHA256 OK: $actual"

    if ($WhatIf) { Write-Host "WhatIf: skipping the install."; return }

    # --- 5. Install silently for the current user ------------------------------
    Write-Host "Installing (silent, current user) ..."
    $p = Start-Process -FilePath $exe -ArgumentList $InstArgs -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "The installer exited with code $($p.ExitCode)." }

    # --- 6. Verify the install ---------------------------------------------------
    $reg = Get-ItemProperty -LiteralPath $UninstKey -ErrorAction SilentlyContinue
    if (-not $reg) { throw "Install finished, but the uninstall entry was not found at $UninstKey." }
    if ($reg.DisplayVersion -ne $Version) { throw "Installed version is '$($reg.DisplayVersion)', expected '$Version'." }
    $appExe = ([string]$reg.DisplayIcon -replace ',\d+$', '').Trim('"')
    if (-not (Test-Path -LiteralPath $appExe)) { throw "App executable not found: $appExe" }
    Write-Host "Installed NV Gateway $($reg.DisplayVersion): $appExe"
}
finally {
    # --- 7. Clean up the temp folder ---------------------------------------------
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  - Start NV Gateway from the Start menu."
Write-Host "  - Default ports: 12000 and 12001 (localhost)."
Write-Host "  - Docs: $RepoUrl#readme"
} $Version $InstallDir $WhatIf.IsPresent
