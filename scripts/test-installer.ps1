$ErrorActionPreference = 'Stop'
if (-not ($IsWindows -or $env:OS -eq 'Windows_NT')) { throw 'Installer verification requires Windows.' }
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$installer = Join-Path $workspace ($package.build.directories.output + '/SaveHub-' + $package.version + '-win-x64.exe')
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Build the Windows installer first.' }
$registryRoots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
foreach ($registryRoot in $registryRoots) {
    if (Test-Path -LiteralPath $registryRoot) {
        $existing = Get-ChildItem -LiteralPath $registryRoot | Get-ItemProperty | Where-Object DisplayName -eq 'SaveHub'
        if ($existing) { throw 'An installed SaveHub already exists; preserve it and use a clean Windows test machine.' }
    }
}
foreach ($shortcutFolder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    if (Test-Path -LiteralPath (Join-Path $shortcutFolder 'SaveHub.lnk')) { throw 'An existing SaveHub shortcut must be preserved; use a clean test machine.' }
}
$testRoot = [IO.Path]::GetFullPath((Join-Path $workspace '.test-data'))
$installRoot = [IO.Path]::GetFullPath((Join-Path $testRoot ('installer-' + [Guid]::NewGuid().ToString('N'))))
if (-not $installRoot.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid test target.' }
$artifactRoot = Join-Path $workspace 'test-results/installer'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$oldExecutable = $env:SAVEHUB_TEST_EXECUTABLE
$oldArtifacts = $env:SAVEHUB_ARTIFACT_ROOT
$failure = $null
$uninstalled = $false
try {
    $setupProcess = Start-Process -FilePath $installer -ArgumentList "/S /currentuser /D=$installRoot" -PassThru -Wait -WindowStyle Hidden
    if ($setupProcess.ExitCode -ne 0) { throw "Installer exited $($setupProcess.ExitCode)." }
    $installedExecutable = Join-Path $installRoot 'SaveHub.exe'
    if (-not (Test-Path -LiteralPath $installedExecutable)) { throw 'Installer did not create SaveHub.exe.' }
    $env:SAVEHUB_TEST_EXECUTABLE = $installedExecutable
    $env:SAVEHUB_ARTIFACT_ROOT = $artifactRoot
    & node (Join-Path $workspace 'node_modules/@playwright/test/cli.js') test --grep '(smoke|retention-interactions)$'
    if ($LASTEXITCODE -ne 0) { throw 'Installed-application regression failed.' }
} catch {
    $failure = $_.Exception.Message
} finally {
    $env:SAVEHUB_TEST_EXECUTABLE = $oldExecutable
    $env:SAVEHUB_ARTIFACT_ROOT = $oldArtifacts
    try {
    $uninstaller = Join-Path $installRoot 'Uninstall SaveHub.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installRoot" -PassThru -Wait -WindowStyle Hidden
        $uninstalled = $uninstallProcess.ExitCode -eq 0
        if (-not $uninstalled -and -not $failure) { $failure = "Uninstaller exited $($uninstallProcess.ExitCode)." }
    }
    if ($uninstalled -and (Test-Path -LiteralPath $installRoot)) {
        $resolvedInstall = (Resolve-Path -LiteralPath $installRoot).Path
        if (-not $resolvedInstall.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup target escaped test root.' }
        Remove-Item -LiteralPath $resolvedInstall -Recurse -Force
    }
    foreach ($registryRoot in $registryRoots) {
        if (Test-Path -LiteralPath $registryRoot) {
            $remaining = Get-ChildItem -LiteralPath $registryRoot | Get-ItemProperty | Where-Object DisplayName -eq 'SaveHub'
            if ($remaining) { throw 'Test installation registry entry remains after uninstall.' }
        }
    }
    } catch {
        if ($failure) { $failure += "; cleanup: $($_.Exception.Message)" } else { $failure = $_.Exception.Message }
    }
    @{ success = (-not $failure -and $uninstalled); version = $package.version; installer = $installer; target = $installRoot; uninstalled = $uninstalled; error = $failure; date = (Get-Date -Format o) } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifactRoot 'installation.json') -Encoding UTF8
}
if ($failure) { throw $failure }
if (-not $uninstalled) { throw 'The test installation was not removed.' }
