# Adds (or removes) an "Agents Dashboard" shortcut on the Desktop and in the Start menu.
# Without -Apply it only shows what it would do.
param([switch]$Apply, [switch]$Remove)

$start = Join-Path $PSScriptRoot 'Start-Dashboard.ps1'
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agents Dashboard.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Agents Dashboard.lnk')
)

foreach ($lnk in $targets) {
    if ($Remove) {
        if (-not (Test-Path $lnk)) { Write-Output "Not found: $lnk"; continue }
        if ($Apply) { Remove-Item $lnk; Write-Output "Removed: $lnk" } else { Write-Output "Would remove: $lnk" }
        continue
    }
    if (-not $Apply) { Write-Output "Would create: $lnk"; continue }
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
    $s.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $s.IconLocation = "$env:SystemRoot\System32\imageres.dll,109"
    $s.Description = 'Open the Agents Dashboard'
    $s.Save()
    Write-Output "Created: $lnk"
}
if (-not $Apply) { Write-Output 'Preview only. Run again with -Apply to make the change.' }
