param(
 [switch]$InstallAtLogon,
 [switch]$IncludePreview,
 [switch]$ResetRecovery,
 [string]$JarvisRoot = (Join-Path $PSScriptRoot '..\..\jarvis-v2'),
 [string]$SpeechUrl = $env:AOS_V2_SPEECH_URL
)
$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskRuntime=Join-Path $taskRoot '.runtime'
$taskConfigFile=Join-Path $taskRuntime 'service-recovery.json'
$taskPauseFile=Join-Path $taskRuntime 'services-paused.json'
$taskNode=(Get-Command node -CommandType Application | Select-Object -First 1).Source
$taskRunner=Join-Path $taskRoot 'runner\service-supervisor.mjs'
$taskWrapper=Join-Path $PSScriptRoot 'run-recovery.ps1'
$taskName='Agentic OS V2 Service Recovery'
$taskSupervisor=$null
try {$taskSupervisor=Invoke-RestMethod 'http://127.0.0.1:3221/status' -TimeoutSec 2} catch {}
if($taskSupervisor -and ($taskSupervisor.kind -ne 'agentic-os-service-supervisor' -or $taskSupervisor.runtimeDir -ne $taskRuntime)){throw 'Port 3221 belongs to another installation; nothing changed.'}
if(!$taskSupervisor -and (Get-NetTCPConnection -LocalPort 3221 -State Listen -ErrorAction SilentlyContinue)){throw 'An unrecognized service owns port 3221; nothing changed.'}
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
if($ResetRecovery -and $taskSupervisor){[System.IO.File]::WriteAllText($taskPauseFile,'{"reason":"explicit recovery reset"}',[System.Text.UTF8Encoding]::new($false))}
# A paused monitor may still be exiting. Do not clear its marker until it leaves.
if($taskSupervisor -and (Test-Path -LiteralPath $taskPauseFile)){
 for($taskAttempt=0;$taskAttempt -lt 20;$taskAttempt++){
  Start-Sleep -Milliseconds 500
  try {$taskSupervisor=Invoke-RestMethod 'http://127.0.0.1:3221/status' -TimeoutSec 1} catch {$taskSupervisor=$null;break}
 }
 if($taskSupervisor){throw 'The recovery monitor is still pausing; try again shortly.'}
}
if($ResetRecovery){
 $taskRecoveryState=Join-Path $taskRuntime 'service-recovery-state.json'
 if(Test-Path -LiteralPath $taskRecoveryState){Remove-Item -LiteralPath $taskRecoveryState}
}
if(!$SpeechUrl){
 foreach($taskPort in @(3220,3108)){
  try {$taskHealth=Invoke-RestMethod "http://127.0.0.1:$taskPort/health" -TimeoutSec 2;if($taskHealth.ok -and $taskHealth.stt.ok){$SpeechUrl="http://127.0.0.1:$taskPort";break}} catch {}
 }
}
$taskEnv=@{}
if($SpeechUrl){$taskEnv.AOS_V2_SPEECH_URL=$SpeechUrl}
if(Test-Path -LiteralPath (Join-Path $taskRuntime 'vault.json')){$taskEnv.AOS_V2_VAULT=(Get-Content -LiteralPath (Join-Path $taskRuntime 'vault.json') -Raw | ConvertFrom-Json).vault}
$taskServices=@(@{id='bridge';port=3219;command=$taskNode;args=@((Join-Path $taskRoot 'runner\bridge.mjs'));cwd=$taskRoot;env=$taskEnv})
if($IncludePreview){$taskServices+=@{id='preview';port=3218;command=$taskNode;args=@((Join-Path $taskRoot 'preview\server.mjs'));cwd=$taskRoot;env=$taskEnv}}
if(Test-Path -LiteralPath (Join-Path $JarvisRoot '.next\BUILD_ID')){
 $taskJarvis=(Resolve-Path $JarvisRoot).Path
 $taskServices+=@{id='jarvis';port=3217;command=$taskNode;args=@((Join-Path $taskJarvis 'node_modules\next\dist\bin\next'),'start','--hostname','127.0.0.1','--port','3217');cwd=$taskJarvis}
}
if($taskSupervisor -and @($taskServices | Where-Object {$_.id -notin @($taskSupervisor.services.id)}).Count){
 # Reconfigure the monitor alone when an existing installation adds preview/Jarvis.
 [System.IO.File]::WriteAllText($taskPauseFile,'{"reason":"recovery services changed"}',[System.Text.UTF8Encoding]::new($false))
 for($taskAttempt=0;$taskAttempt -lt 20;$taskAttempt++){
  Start-Sleep -Milliseconds 500
  try {$taskSupervisor=Invoke-RestMethod 'http://127.0.0.1:3221/status' -TimeoutSec 1}catch{$taskSupervisor=$null;break}
 }
 if($taskSupervisor){throw 'The recovery monitor is still reconfiguring; try again shortly.'}
}
if(!$taskSupervisor){
 # Subsequent normal starts keep the configured set of services, including Jarvis.
 if(Test-Path -LiteralPath $taskConfigFile){
  $taskPrior=Get-Content -LiteralPath $taskConfigFile -Raw | ConvertFrom-Json
  if($taskPrior.runtimeDir -ne $taskRuntime){throw 'Recovery configuration belongs to another installation.'}
  foreach($taskService in $taskPrior.services){
   if($taskService.id -notin @($taskServices.id) -and $taskService.id -in @('preview','jarvis')){$taskServices+=$taskService}
  }
 }
 $taskConfig=@{runtimeDir=$taskRuntime;lockPort=3221;services=$taskServices}
 $taskTemporary=Join-Path $taskRuntime ('service-recovery.'+[guid]::NewGuid().ToString()+'.tmp')
 [System.IO.File]::WriteAllText($taskTemporary,($taskConfig | ConvertTo-Json -Depth 8),[System.Text.UTF8Encoding]::new($false))
 Move-Item -LiteralPath $taskTemporary -Destination $taskConfigFile -Force
}
# Same rule as scripts/aos/autostart.mjs taskOwner: parse the exact shape this launcher registers
# (with or without the policy bypass) and require our wrapper and configuration file; never a substring.
function Test-OurRecoveryTask($task){
 $actions=@($task.Actions)
 if($actions.Count -ne 1){return $false}
 if(([string]$actions[0].Execute).Trim('"') -notmatch '(^|[\\/])powershell\.exe$'){return $false}
 $shape='^-NoProfile -NonInteractive (?:-ExecutionPolicy Bypass )?-WindowStyle Hidden -File "([^"]+)" -NodeExecutable "([^"]+)" -ConfigFile "([^"]+)"$'
 if(([string]$actions[0].Arguments).Trim() -notmatch $shape){return $false}
 $same={param($a,$b) [System.IO.Path]::GetFullPath($a).TrimEnd('\').Equals([System.IO.Path]::GetFullPath($b).TrimEnd('\'),[System.StringComparison]::OrdinalIgnoreCase)}
 return (& $same $Matches[1] $taskWrapper) -and (& $same $Matches[3] $taskConfigFile)
}
if($InstallAtLogon){
 $taskPowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 if(!(Test-Path -LiteralPath $taskPowerShell)){throw 'Windows PowerShell is unavailable for the recovery task.'}
 # Bypass applies to this one process: a fresh Windows (policy Restricted) otherwise refuses -File. No policy is changed.
 $taskArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$taskWrapper+'" -NodeExecutable "'+$taskNode+'" -ConfigFile "'+$taskConfigFile+'"'
 $taskExisting=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
 if($taskExisting -and !(Test-OurRecoveryTask $taskExisting)){throw 'A different installation owns the recovery task; nothing replaced.'}
 $taskIdentity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
 $taskAction=New-ScheduledTaskAction -Execute $taskPowerShell -Argument $taskArguments -WorkingDirectory $taskRoot
 $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskIdentity
 $taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskIdentity -LogonType Interactive -RunLevel Limited
 $taskSettings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
 Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Keeps local Agentic OS V2 web and voice bridge services available. Never replays voice requests or resumes saved tasks. Intentional Stop pauses recovery.' -Force | Out-Null
}
if(Test-Path -LiteralPath $taskPauseFile){Remove-Item -LiteralPath $taskPauseFile}
if($taskSupervisor){Write-Output 'Recovery is already running. Existing services and conversations were retained.';return}
$taskScheduled=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($taskScheduled){
 if(!(Test-OurRecoveryTask $taskScheduled)){throw 'A different installation owns the recovery task.'}
 # Let a previous intentional stop finish before asking Task Scheduler to start again.
 for($taskAttempt=0;$taskAttempt -lt 20 -and (Get-ScheduledTask -TaskName $taskName).State -eq 'Running';$taskAttempt++){Start-Sleep -Milliseconds 500}
 Start-ScheduledTask -TaskName $taskName
}else{
 $taskProcess=Start-Process -FilePath $taskNode -ArgumentList @(('"'+$taskRunner+'"'),'--config',('"'+$taskConfigFile+'"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru
 Write-Output "Recovery monitor started: $($taskProcess.Id)"
}
for($taskAttempt=0;$taskAttempt -lt 24;$taskAttempt++){
 Start-Sleep -Milliseconds 500
 try {$taskReady=Invoke-RestMethod 'http://127.0.0.1:3221/status' -TimeoutSec 1;if($taskReady.runtimeDir -eq $taskRuntime){Write-Output 'Local service recovery is active on 127.0.0.1:3221.';return}}catch{}
}
throw 'The recovery monitor did not become available. Inspect .runtime/service-supervisor.jsonl and the Windows task result.'
