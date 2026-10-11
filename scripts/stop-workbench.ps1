$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $root '.agent-data\preview.lock'

if (-not (Test-Path -LiteralPath $lockPath)) {
  Write-Output 'Workbench is not running.'
  exit 0
}

$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$pidValue = [int]$lock.pid
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue

if (-not $process) {
  Remove-Item -LiteralPath $lockPath -Force
  Write-Output "Removed stale Workbench lock for PID $pidValue."
  exit 0
}

$expectedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
$lockRoot = if ($lock.root) { [System.IO.Path]::GetFullPath([string]$lock.root).TrimEnd('\') } else { $null }
$rootMatches = $lockRoot -and [string]::Equals($lockRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)
$commandLine = [string]$process.CommandLine
if ($commandLine -notmatch '(?:backend[\\/]+workbench|prototype)[\\/]+(?:workbench|server)\.js') {
  throw "PID $pidValue in preview.lock is not this project's Workbench. Aborting."
}
if (-not $rootMatches) {
  if ($commandLine -notmatch '(?:backend[\\/]+workbench|prototype)[\\/]+server\.js') {
    throw "PID $pidValue in preview.lock does not identify this project's root. Aborting."
  }
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:59160/api/health' -TimeoutSec 3
  } catch {
    throw "Cannot verify the project root for PID $pidValue in preview.lock. Aborting."
  }
  $healthRoot = if ($health.root) { [System.IO.Path]::GetFullPath([string]$health.root).TrimEnd('\') } else { $null }
  if ([int]$health.pid -ne $pidValue -or -not [string]::Equals($healthRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "PID $pidValue in preview.lock is not serving this project's Workbench. Aborting."
  }
}

Write-Output "Stopping Workbench (PID $pidValue)..."
Stop-Process -Id $pidValue

$deadline = (Get-Date).AddSeconds(5)
do {
  Start-Sleep -Milliseconds 200
  $stillRunning = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
} while ($stillRunning -and (Get-Date) -lt $deadline)

if ($stillRunning) {
  Write-Output 'Workbench did not exit within 5 seconds; forcing termination...'
  Stop-Process -Id $pidValue -Force
  Start-Sleep -Milliseconds 300
}

if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
  throw "Could not stop Workbench (PID $pidValue)."
}

if (Test-Path -LiteralPath $lockPath) {
  $currentLock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  if ([int]$currentLock.pid -eq $pidValue) {
    Remove-Item -LiteralPath $lockPath -Force
  }
}

Write-Output 'Workbench stopped.'
