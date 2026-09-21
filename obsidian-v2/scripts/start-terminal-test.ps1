param([string]$LogDirectory=(Join-Path $PSScriptRoot '..\.runtime\terminal-test'))
$ErrorActionPreference='Stop'
# LogDirectory is retained for existing callers. Recovery metadata lives in .runtime.
& (Join-Path $PSScriptRoot 'start-recovery.ps1') -IncludePreview
Write-Output 'Open http://127.0.0.1:3218/ or Agentic OS V2 in Obsidian. Built sibling Jarvis runs on 3217.'
Write-Output 'Shared speech is reused; no legacy queue worker or saved agent task is started.'