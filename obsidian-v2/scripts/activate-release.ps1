param(
 [string]$Label=(Get-Date -Format 'yyyy-MM-dd-HHmm'),
 [switch]$SkipJarvisBuild,
 [switch]$SkipTests,
 [switch]$CheckOnly,
 [string]$LogDirectory=(Join-Path $PSScriptRoot '..\.runtime\activations')
)
$ErrorActionPreference='Stop'
# Release the current repository state: run the suite and build the plugin, verify
# idle state, stop the bridge gracefully, stop Jarvis and the component preview,
# rebuild Jarvis, restart everything through service recovery, wait for the bridge,
# THEN install the plugin. Installing last lets the Hot Reload marker reload the
# native plugin with the bridge already online.
$taskObsidian=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskJarvis=(Resolve-Path (Join-Path $taskObsidian '..\jarvis-v2')).Path
$taskNode=(Get-Command node -CommandType Application | Select-Object -First 1).Source
$taskNpm=(Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if(!$taskNpm){$taskNpm=(Get-Command npm -CommandType Application | Select-Object -First 1).Source}
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogDirectory=(Resolve-Path $LogDirectory).Path
function Write-Step([string]$text){Write-Host ("[activate] "+$text)}
$taskRepoVersion=(Get-Content -LiteralPath (Join-Path $taskObsidian 'manifest.json') -Raw | ConvertFrom-Json).version
$taskVault=(Get-Content -LiteralPath (Join-Path $taskObsidian '.runtime\vault.json') -Raw | ConvertFrom-Json).vault

# 2. Refuse while anything is live.
$taskBefore=Invoke-RestMethod 'http://127.0.0.1:3219/services' -TimeoutSec 8
$taskWork=Invoke-RestMethod 'http://127.0.0.1:3219/work' -TimeoutSec 5
if(@($taskBefore.surfaces | Where-Object {$_.mode -notin @('idle','error')}).Count){throw 'A voice surface is active. No service changed.'}
if(@($taskBefore.tasks | Where-Object {$_.state -notin @('stopped','error','closed')}).Count){throw 'A task is active. No service changed.'}
if(@($taskWork.tasks | Where-Object {$_.pid -or $_.state -notin @('stopped','error')}).Count){throw 'A terminal is active. No service changed.'}
$taskBridgeState=Invoke-RestMethod 'http://127.0.0.1:3219/state' -TimeoutSec 5
if($taskBridgeState.vault -ne $taskVault){throw 'Bridge vault identity mismatch; nothing stopped.'}
$taskNativeBefore=@($taskBefore.surfaces | Where-Object {$_.kind -eq 'native'} | Select-Object -First 1)
@{label=$Label;version=$taskRepoVersion;bridgePid=$taskBefore.bridge.pid;surfaces=@($taskBefore.surfaces | Select-Object id,kind,version,mode);current=$taskWork.current;currentRevision=$taskWork.currentRevision;tasks=@($taskBefore.tasks | Select-Object id,state)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $LogDirectory ("before-"+$Label+".json"))

# 3. Identify the processes this script may stop.
function Get-ListenerProcess([int]$port,[string]$expectedFragment,[string]$expectedArgs){
 $listener=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -eq '127.0.0.1'} | Select-Object -First 1
 if(!$listener){return $null}
 $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
 if(!$process -or $process.Name -ne 'node.exe' -or !$process.CommandLine.Contains($expectedFragment) -or ($expectedArgs -and $process.CommandLine -notmatch $expectedArgs)){throw "Process identity mismatch on port $port; nothing stopped."}
 return $process
}
$taskJarvisProcess=Get-ListenerProcess 3217 (Join-Path $taskJarvis 'node_modules\next\dist\bin\next') 'start --hostname 127\.0\.0\.1 --port 3217'
$taskPreviewProcess=Get-ListenerProcess 3218 (Join-Path $taskObsidian 'preview\server.mjs') ''
$taskBuildPath=[IO.Path]::GetFullPath((Join-Path $taskJarvis '.next'))
$taskBackupPath=[IO.Path]::GetFullPath((Join-Path $taskJarvis ('.runtime\next-before-'+$Label)))
$taskFailedPath=[IO.Path]::GetFullPath((Join-Path $taskJarvis ('.runtime\next-failed-'+$Label)))
foreach($taskPath in @($taskBuildPath,$taskBackupPath,$taskFailedPath)){
 if(!$taskPath.StartsWith($taskJarvis+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected build path; no service changed.'}
}
if(!$SkipJarvisBuild -and (Test-Path -LiteralPath $taskBackupPath)){throw "Build backup $taskBackupPath already exists. Choose another -Label; no service changed."}
if($CheckOnly){
 [ordered]@{checkOnly=$true;version=$taskRepoVersion;vault=$taskVault;bridgePid=$taskBefore.bridge.pid;jarvisPid=$(if($taskJarvisProcess){$taskJarvisProcess.ProcessId}else{$null});previewPid=$(if($taskPreviewProcess){$taskPreviewProcess.ProcessId}else{$null});nativeConnected=[bool]$taskNativeBefore.Count;readyToActivate=$true} | ConvertTo-Json
 return
}

# 4. Test and build the plugin from the current source before any service is touched.
Push-Location $taskObsidian
try{
 if(!$SkipTests){
  Write-Step 'Running the Obsidian suite'
  $taskTestLog=Join-Path $LogDirectory ("obsidian-tests-"+$Label+".log")
  & $taskNode --test --test-concurrency=4 --test-timeout=45000 'tests/*.test.mjs' *> $taskTestLog
  if($LASTEXITCODE -ne 0){Get-Content -LiteralPath $taskTestLog | Select-String -Pattern '^not ok|^# (pass|fail)' | Select-Object -First 20;throw 'The Obsidian suite failed; nothing changed.'}
 }
 Write-Step ('Building plugin '+$taskRepoVersion)
 $taskBuildLog=Join-Path $LogDirectory ("obsidian-build-"+$Label+".log")
 & $taskNpm run build *> $taskBuildLog
 if($LASTEXITCODE -ne 0){Get-Content -LiteralPath $taskBuildLog -Tail 25;throw 'The plugin build failed; nothing changed.'}
}finally{Pop-Location}
$taskDistManifest=Join-Path $taskObsidian 'dist\agentic-os-v2\manifest.json'
$taskDistVersion=(Get-Content -LiteralPath $taskDistManifest -Raw | ConvertFrom-Json).version
if($taskDistVersion -ne $taskRepoVersion){throw "The build produced $taskDistVersion but the repository is $taskRepoVersion; nothing changed."}

$taskStopped=$false;$taskBuildSucceeded=$SkipJarvisBuild.IsPresent
try{
 # 4. Graceful bridge shutdown (pauses recovery), then stop Jarvis and the preview.
 $taskAuth=Get-Content -LiteralPath (Join-Path $taskObsidian '.runtime\bridge-auth.json') -Raw | ConvertFrom-Json
 $taskStopped=$true
 Write-Step 'Stopping the idle bridge'
 Invoke-RestMethod 'http://127.0.0.1:3219/shutdown' -Method Post -Headers @{'X-V2-App'='native';'X-V2-Token'=$taskAuth.token} -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
 foreach($taskProcess in @($taskJarvisProcess,$taskPreviewProcess)){
  if(!$taskProcess){continue}
  $taskCurrent=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.ProcessId)"
  if($taskCurrent -and $taskCurrent.CreationDate -eq $taskProcess.CreationDate){Stop-Process -Id $taskProcess.ProcessId}
 }
 # 5. Rebuild Jarvis from a clean output folder, keeping the previous build.
 if(!$SkipJarvisBuild){
  Write-Step 'Rebuilding Jarvis'
  if(Test-Path -LiteralPath $taskBuildPath){Move-Item -LiteralPath $taskBuildPath -Destination $taskBackupPath}
  Push-Location $taskJarvis
  try{
   $taskJarvisLog=Join-Path $LogDirectory ("jarvis-build-"+$Label+".log")
   & $taskNode node_modules/next/dist/bin/next build *> $taskJarvisLog
   if($LASTEXITCODE -ne 0){Get-Content -LiteralPath $taskJarvisLog -Tail 25;throw 'Jarvis build failed.'}
   $taskBuildSucceeded=$true
  }finally{Pop-Location}
 }
}finally{
 if($taskStopped){
  if(!$taskBuildSucceeded -and (Test-Path -LiteralPath $taskBackupPath)){
   if(Test-Path -LiteralPath $taskBuildPath){Move-Item -LiteralPath $taskBuildPath -Destination $taskFailedPath}
   Move-Item -LiteralPath $taskBackupPath -Destination $taskBuildPath
  }
  # 6. Restart bridge, preview and Jarvis through recovery before touching the plugin.
  Write-Step 'Restarting services through recovery'
  & (Join-Path $PSScriptRoot 'start-recovery.ps1') -IncludePreview
 }
}
if(!$taskBuildSucceeded){throw 'Jarvis build failed; previous build restored and services restarted. Plugin not installed.'}

# 7. Wait for the bridge to answer, so the automatic plugin reload finds it online.
$taskDeadline=(Get-Date).AddSeconds(120);$taskBridge=$null
while((Get-Date) -lt $taskDeadline){
 try{$taskBridge=Invoke-RestMethod 'http://127.0.0.1:3219/status' -TimeoutSec 3;break}catch{Start-Sleep -Seconds 2}
}
if(!$taskBridge){throw 'The bridge did not come back within 120 s. Check scripts/services.ps1 -Action Status; plugin not installed.'}
if($taskBridge.vault -ne $taskVault){throw 'The restarted bridge serves a different vault; plugin not installed.'}
Write-Step ("Bridge online as PID "+$taskBridge.health.pid)

# 8. Install the plugin last. With the .hotreload marker, Obsidian reloads it by itself.
Write-Step ("Installing plugin "+$taskRepoVersion)
& $taskNode (Join-Path $taskObsidian 'scripts\install-live.mjs') $taskVault
if($LASTEXITCODE -ne 0){throw 'Plugin installation failed. Services are running the new runner; the previous plugin bundle is in .runtime\backups.'}

# 9. Report the loaded native version when Obsidian was connected before.
$taskLoaded=$null
if($taskNativeBefore.Count){
 $taskDeadline=(Get-Date).AddSeconds(45)
 while((Get-Date) -lt $taskDeadline){
  try{$taskServices=Invoke-RestMethod 'http://127.0.0.1:3219/services' -TimeoutSec 3}catch{$taskServices=$null}
  $taskNative=@($taskServices.surfaces | Where-Object {$_.kind -eq 'native' -and $_.id -ne $taskNativeBefore[0].id -and $_.version -eq $taskRepoVersion})
  if($taskNative.Count){$taskLoaded=$taskNative[0];break}
  Start-Sleep -Seconds 3
 }
}
$taskSummary=[ordered]@{label=$Label;version=$taskRepoVersion;bridgePid=$taskBridge.health.pid;jarvisRebuilt=(!$SkipJarvisBuild);nativeReloaded=[bool]$taskLoaded;nativeVersion=$(if($taskLoaded){$taskLoaded.version}elseif($taskNativeBefore.Count){$taskNativeBefore[0].version+' (not reloaded yet; reload Agentic OS V2 or check the Hot Reload plugin)'}else{'Obsidian not connected'})}
$taskSummary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $LogDirectory ("after-"+$Label+".json"))
$taskSummary | ConvertTo-Json
