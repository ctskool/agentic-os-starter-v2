param(
 [Parameter(Mandatory=$true)][string]$NodeExecutable,
 [Parameter(Mandatory=$true)][string]$ConfigFile,
 [ValidateRange(0,10)][int]$MaxRestarts=3,
 [ValidateRange(1,60)][int]$RetryDelaySeconds=5
)
$ErrorActionPreference='Stop'
function Write-RecoveryDiagnostic([string]$Message){
 try{[System.IO.File]::WriteAllText($taskErrorLog,($Message.Substring(0,[Math]::Min(180,$Message.Length))),[System.Text.UTF8Encoding]::new($false))}catch{}
}
try {
 $taskRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
 $taskRunner=Join-Path $taskRoot 'runner\service-supervisor.mjs'
 $taskErrorLog=Join-Path (Split-Path -Parent $ConfigFile) 'service-supervisor-startup-error.log'
 $taskPauseFile=Join-Path ((Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json).runtimeDir) 'services-paused.json'
 $taskRestarts=0
 while($true){
  if(Test-Path -LiteralPath $taskPauseFile){exit 0}
  try{
   # Task Scheduler owns this hidden wrapper independently of the launching terminal.
   # Avoid PowerShell 5 redirection and -Wait: services must outlive their monitor.
   $taskProcess=Start-Process -FilePath $NodeExecutable -ArgumentList @(('"'+$taskRunner+'"'),'--config',('"'+$ConfigFile+'"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru
   # Cache the handle before a fast-failing monitor disappears; wait for this PID only.
   $taskHandle=$taskProcess.Handle
   $taskProcess.WaitForExit()
   $taskExitCode=$taskProcess.ExitCode
   if($null -eq $taskExitCode){throw 'Recovery monitor exit code unavailable.'}
  }catch{
   $taskExitCode=1
   Write-RecoveryDiagnostic ($_.Exception.GetType().Name+' '+$_.FullyQualifiedErrorId)
  }
  if($taskExitCode -eq 0 -or (Test-Path -LiteralPath $taskPauseFile)){exit 0}
  Write-RecoveryDiagnostic "Recovery monitor exited with code $taskExitCode. Restarts used: $taskRestarts/$MaxRestarts. Inspect service-supervisor.jsonl."
  if($taskRestarts -ge $MaxRestarts){exit $taskExitCode}
  $taskDelay=[Math]::Min(60,$RetryDelaySeconds*[Math]::Pow(2,$taskRestarts))
  $taskRetryAt=[DateTime]::UtcNow.AddSeconds($taskDelay)
  # Intentional Stop also cancels a pending retry, without stopping any service.
  while([DateTime]::UtcNow -lt $taskRetryAt){
   if(Test-Path -LiteralPath $taskPauseFile){exit 0}
   Start-Sleep -Milliseconds 250
  }
  $taskRestarts++
 }
}catch{
 if($taskErrorLog){Write-RecoveryDiagnostic ($_.Exception.GetType().Name+' '+$_.FullyQualifiedErrorId)}
 exit 1
}
