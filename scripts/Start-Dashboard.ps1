# Starts the Agents Dashboard server (hidden) if it isn't running, then opens it in its own Edge window.
param([int]$Port = 4327, [switch]$NoBrowser)

$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port"
# Ask the server itself; port lookups can miss a running process.
$listening = $false
try { Invoke-WebRequest "$url/api/state" -UseBasicParsing -TimeoutSec 2 | Out-Null; $listening = $true } catch { }

if (-not $listening) {
    $node = (Get-Command node -ErrorAction Stop).Source
    $logDir = Join-Path $root '.local'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $env:PORT = "$Port"
    Start-Process -FilePath $node -ArgumentList "`"$root\server\index.mjs`"" -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server.err.log')
    # Wait up to 5 seconds for the server to answer.
    for ($i = 0; $i -lt 20; $i++) {
        try { Invoke-WebRequest "$url/api/state" -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 250 }
    }
}

if (-not $NoBrowser) {
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($edge) { Start-Process $edge "--app=$url" } else { Start-Process $url }
}
Write-Output "Agents Dashboard: $url"
