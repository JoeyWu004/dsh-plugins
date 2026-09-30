#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deploy the self-written DSH plugins from this directory into DSH.

.DESCRIPTION
    This directory is the single source of truth for the plugins below. Deployment
    has two hops and is idempotent:

      1. <this directory>\<plugin>                  -> $DSH_HOME\plugins\<plugin>
      2. $DSH_HOME\plugins\<plugin>                 -> $DSH_HOME\profiles\<Profile>\node_modules\<plugin>

    The second hop is the location DSH actually loads. The profile's
    cordis.patch.yml must also carry an insert entry for each plugin; a missing
    entry is appended (the file is backed up first).

    Each destination is mirrored from its source: files present in the source are
    copied over, and files absent from the source are deleted. A file that exists
    in the source is never removed.

    The desktop application ships its own packed dsh (desktop\resources\app.asar);
    it reads neither this directory nor the repository sources. A plugin takes
    effect only after it lands in the profile's node_modules, is registered in
    cordis.patch.yml, and the application restarts.

    Messages are ASCII on purpose: Windows PowerShell 5.1 decodes a BOM-less
    UTF-8 script as ANSI, which would garble non-ASCII output.

.PARAMETER Profile
    Target profile name. Defaults to desktop.

.PARAMETER Source
    Plugin source directory. Defaults to the directory holding this script.

.EXAMPLE
    pwsh -File "D:\deepseek-harness\local-plugins\deploy.ps1"
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$Source
)

$ErrorActionPreference = 'Stop'

if (-not $Source) { $Source = $PSScriptRoot }
$Source = (Resolve-Path -LiteralPath $Source).Path

$dshHome     = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$pluginsRoot = Join-Path $dshHome 'plugins'
$profileDir  = Join-Path $dshHome "profiles\$Profile"
$modulesDir  = Join-Path $profileDir 'node_modules'
$patchPath   = Join-Path $profileDir 'cordis.patch.yml'

# Plugin directory name -> registration id used by cordis.patch.yml
$plugins = [ordered]@{
    'dsh-plugin-session-purge'      = 'session-purge'
    'dsh-client-ui-account-balance' = 'ui-account-balance'
}

Write-Host "source      : $Source"
Write-Host "DSH home    : $dshHome"
Write-Host "profile     : $profileDir"
Write-Host ''

if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile directory not found: $profileDir (start the desktop application once so it initializes the profile)"
}
if (-not (Test-Path -LiteralPath $modulesDir)) { New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null }
if (-not (Test-Path -LiteralPath $pluginsRoot)) { New-Item -ItemType Directory -Force -Path $pluginsRoot | Out-Null }

# Copy every source file over the destination, then delete destination files the
# source does not have. Mirroring keeps stale files from surviving a rename or a
# deletion in the source.
function Sync-Tree {
    param([string]$From, [string]$To)
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    Copy-Item (Join-Path $From '*') $To -Recurse -Force
    $srcFiles = @(Get-ChildItem -LiteralPath $From -Recurse -File | ForEach-Object {
        $_.FullName.Substring($From.Length).TrimStart('\')
    })
    $removed = 0
    foreach ($rel in @(Get-ChildItem -LiteralPath $To -Recurse -File | ForEach-Object {
        $_.FullName.Substring($To.Length).TrimStart('\')
    })) {
        if ($srcFiles -notcontains $rel) {
            Remove-Item -LiteralPath (Join-Path $To $rel) -Force
            Write-Host "    - removed stale file: $rel"
            $removed++
        }
    }
    return $removed
}

# --- 1. source -> stable copy -> loaded location ------------------------------
$deployed = 0
foreach ($name in $plugins.Keys) {
    $from = Join-Path $Source $name
    if (-not (Test-Path -LiteralPath $from)) { Write-Warning "missing plugin in source, skipped: $from"; continue }

    $stable = Join-Path $pluginsRoot $name
    $loaded = Join-Path $modulesDir $name

    [void](Sync-Tree -From $from -To $stable)
    [void](Sync-Tree -From $stable -To $loaded)

    $files = @(Get-ChildItem -LiteralPath $loaded -Recurse -File).Count
    Write-Host "  [ok] $name -> ~/.dsh/plugins and profile/node_modules ($files files)"
    $deployed++
}

# --- 2. ensure cordis.patch.yml registers every plugin ------------------------
if (-not (Test-Path -LiteralPath $patchPath)) {
    Write-Warning "patch layer not found, creating: $patchPath"
    [System.IO.File]::WriteAllText($patchPath, '', (New-Object System.Text.UTF8Encoding($false)))
}

$patch = [System.IO.File]::ReadAllText($patchPath)
$missing = @()
foreach ($name in $plugins.Keys) {
    $id = $plugins[$name]
    # Match either the package name or a `- id: <id>` line, so a repeated run never appends twice.
    if ($patch -notmatch [regex]::Escape($name) -and $patch -notmatch "(?m)^\s*-\s*id:\s*$([regex]::Escape($id))\s*$") {
        $missing += [pscustomobject]@{ Name = $name; Id = $id }
    }
}

if ($missing.Count -eq 0) {
    Write-Host '  [ok] cordis.patch.yml already registers every plugin'
} else {
    Copy-Item -LiteralPath $patchPath -Destination "$patchPath.bak" -Force
    Write-Host "  backup written: $patchPath.bak"
    $addition = "`n# appended by local-plugins/deploy.ps1`n"
    foreach ($entry in $missing) {
        $addition += "- insert:`n    - id: $($entry.Id)`n      name: '$($entry.Name)'`n"
        Write-Host "  [ok] registered $($entry.Name) (id: $($entry.Id))"
    }
    [System.IO.File]::WriteAllText($patchPath, $patch + $addition, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
Write-Host "done: $deployed plugin(s) deployed, $($missing.Count) registration entry(ies) appended."
Write-Host 'Restart the desktop application so it reloads the plugins.'
