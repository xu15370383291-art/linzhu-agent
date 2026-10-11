[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path.TrimEnd('\')
$targets = @(Get-ChildItem -LiteralPath $root -Directory -Force -Filter '.test-gateway-sandbox-flow-*')
$generatedFiles = @(
  'test-output.txt',
  'sandbox-ui-verification.txt',
  'frontend\workbench\preview-server.log',
  'frontend\workbench\preview-server-error.log',
  'frontend\workbench\models-server.log',
  'frontend\workbench\models-server-error.log',
  '.codex\workbench-startup.log',
  '.codex\workbench-startup.err.log'
)
foreach ($relative in $generatedFiles) {
  $candidate = Join-Path $root $relative
  if (Test-Path -LiteralPath $candidate) { $targets += Get-Item -LiteralPath $candidate -Force }
}
$bytecode = Join-Path $root 'backend\sandbox\__pycache__'
if (Test-Path -LiteralPath $bytecode) { $targets += Get-Item -LiteralPath $bytecode -Force }
$storage = Join-Path $root 'backend\storage'
if ((Test-Path -LiteralPath $storage) -and @(Get-ChildItem -LiteralPath $storage -Force).Count -eq 0) {
  $targets += Get-Item -LiteralPath $storage -Force
}

# Validate every target before deleting any file; linked paths are never followed.
foreach ($item in $targets) {
  $resolved = (Resolve-Path -LiteralPath $item.FullName).Path
  if (-not $resolved.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Cleanup target is outside the project: $resolved"
  }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing linked cleanup target: $resolved"
  }
  if ($item.PSIsContainer) {
    $linked = Get-ChildItem -LiteralPath $resolved -Recurse -Force |
      Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 }
    if ($linked) { throw "Refusing a cleanup directory containing links: $resolved" }
  }
}

$removed = 0
$bytes = 0
foreach ($item in $targets) {
  if ($PSCmdlet.ShouldProcess($item.FullName, 'Remove confirmed generated files')) {
    if ($item.PSIsContainer) {
      $bytes += (Get-ChildItem -LiteralPath $item.FullName -File -Recurse -Force |
        Measure-Object -Property Length -Sum).Sum
    } else { $bytes += $item.Length }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
    $removed++
  }
}
Write-Output "Removed $removed generated targets; reclaimed $([math]::Round($bytes / 1MB, 2)) MB."
Write-Output 'Private runtime data, reports, screenshots and dependencies were preserved.'
