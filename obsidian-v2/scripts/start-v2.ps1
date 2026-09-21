param(
 [string]$SpeechAssets = "$env:USERPROFILE\projects\jarvis-hud\voice-server",
 [string]$SpeechPython = "$env:USERPROFILE\projects\jarvis-hud\voice-server\.venv\Scripts\python.exe",
 [string]$LogDirectory = (Join-Path $PSScriptRoot '..\.runtime')
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$logRoot = (Resolve-Path $LogDirectory).Path
function Start-V2Process($Name,$Executable,$Arguments,$Port) {
 if ($Port -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { Write-Output "$Name already listening on $Port"; return }
 $pidFile = Join-Path $logRoot "$Name.pid"
 if (Test-Path -LiteralPath $pidFile) {
  $previousPid = [int](Get-Content -LiteralPath $pidFile)
  $taskPrevious=Get-CimInstance Win32_Process -Filter "ProcessId=$previousPid"
  # Windows reuses PIDs. A stale PID alone never proves that speech is still starting.
  if ($taskPrevious -and $taskPrevious.ExecutablePath -eq $Executable -and $taskPrevious.CommandLine -match 'runner[/\\]speech\.py' -and $taskPrevious.CommandLine.Contains($SpeechAssets)) { Write-Output "$Name already starting ($previousPid)"; return }
 }
 $started = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot "$Name.log") -RedirectStandardError (Join-Path $logRoot "$Name-error.log") -PassThru
 $started.Id | Set-Content -LiteralPath $pidFile
 Write-Output "$Name started ($($started.Id))"
}
$taskExistingSpeech=$null
foreach($taskPort in @(3220,3108)) {try{$taskCheck=Invoke-RestMethod "http://127.0.0.1:$taskPort/health" -TimeoutSec 2;if($taskCheck.ok -and $taskCheck.stt.ok){$taskExistingSpeech="http://127.0.0.1:$taskPort";break}}catch{}}
if($taskExistingSpeech){$env:AOS_V2_SPEECH_URL=$taskExistingSpeech;Write-Output "Reusing speech: $taskExistingSpeech"}
else {
 if (!(Test-Path -LiteralPath $SpeechPython)) { throw "Speech Python not found: $SpeechPython" }
 foreach ($asset in @('kokoro-v1.0.onnx','voices-v1.0.bin')) { if (!(Test-Path -LiteralPath (Join-Path $SpeechAssets $asset))) { throw "Missing speech asset: $asset" } }
 Start-V2Process 'v2-speech' $SpeechPython @('-u','runner/speech.py','--assets',('"'+$SpeechAssets+'"')) 3220
 $env:AOS_V2_SPEECH_URL='http://127.0.0.1:3220'
}
& (Join-Path $PSScriptRoot 'start-recovery.ps1') -SpeechUrl $env:AOS_V2_SPEECH_URL
Write-Output 'Skills now open persistent terminals. The retired queue worker is not started.'
