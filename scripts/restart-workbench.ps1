$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'stop-workbench.ps1')
Write-Output 'Starting Workbench...'
npm run workbench
