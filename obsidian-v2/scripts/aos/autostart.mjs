// Start-at-login. Windows: the same Scheduled Task start-recovery.ps1 installs
// (hidden run-recovery.ps1 wrapper). macOS: a per-user LaunchAgent. Either one
// is only replaced, started or removed when it provably points at THIS checkout:
// a same-named task or a loaded job that does not is "other", never "absent".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {samePath} from './platform.mjs';

export const TASK_NAME = 'Agentic OS V2 Service Recovery';
export const AGENT_LABEL = 'com.agentic-os-v2.recovery';
const agentFile = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
const wrapperOf = at => path.join(at.root, 'scripts', 'run-recovery.ps1');
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Pure. launchd starts jobs with a bare PATH, so the one captured at install
// time (node, homebrew, the CLIs) travels with the job.
export function launchAgentPlist({node, supervisor, config, cwd, pathEnv, log}) {
  const strings = [node, supervisor, '--config', config].map(value => `    <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathEnv)}</string></dict>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

// Pure. One PowerShell script; every path is passed single-quoted.
export function scheduledTaskScript({node, config, wrapper, cwd}) {
  const q = value => `'${String(value).replace(/'/g, "''")}'`;
  return [
    `$ErrorActionPreference='Stop'`,
    `$ps=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'`,
    `$arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+${q(wrapper)}+'" -NodeExecutable "'+${q(node)}+'" -ConfigFile "'+${q(config)}+'"'`,
    `$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name`,
    `$action=New-ScheduledTaskAction -Execute $ps -Argument $arguments -WorkingDirectory ${q(cwd)}`,
    `$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity`,
    `$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited`,
    `$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden`,
    `Register-ScheduledTask -TaskName ${q(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keeps local Agentic OS V2 web and voice bridge services available. Never replays voice requests or resumes saved tasks. Intentional Stop pauses recovery.' -Force | Out-Null`,
  ].join(';');
}

function powershell(script, run = spawnSync) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return run(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', windowsHide: true, timeout: 30000});
}

// Ownership is decided by PARSING the exact shape this launcher registers, never by searching
// for our paths inside someone else's command. Anything that exists and does not parse to our
// wrapper / monitor AND our configuration file is 'other'; so is a question that cannot be answered.
const TASK_ARGUMENTS = /^-NoProfile -NonInteractive -WindowStyle Hidden -File "([^"]+)" -NodeExecutable "([^"]+)" -ConfigFile "([^"]+)"$/;
export function taskOwner(text, at) {
  let task; try { task = JSON.parse(String(text || '').replace(/^\uFEFF/, '').trim()); } catch { return 'other'; }
  if (task?.exists === false && !task.error) return null;
  if (task?.exists !== true || task.error) return 'other';
  const actions = Array.isArray(task.actions) ? task.actions : [];
  if (actions.length !== 1 || !/(^|[\\/])powershell\.exe$/i.test(String(actions[0].execute || '').replace(/^"|"$/g, ''))) return 'other';
  const parsed = TASK_ARGUMENTS.exec(String(actions[0].arguments || '').trim());
  return parsed && samePath(parsed[1], wrapperOf(at)) && samePath(parsed[3], at.config) ? 'ours' : 'other';
}
const TASK_QUERY = `try{$t=@(Get-ScheduledTask -ErrorAction Stop|Where-Object{$_.TaskName -eq '${TASK_NAME}'});if($t.Count -eq 0){'{"exists":false}'}elseif($t.Count -gt 1){'{"error":true}'}else{@{exists=$true;actions=@($t[0].Actions|ForEach-Object{@{execute=[string]$_.Execute;arguments=[string]$_.Arguments}})}|ConvertTo-Json -Compress -Depth 4}}catch{'{"error":true}'}`;

const unxml = value => String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export function plistArguments(text) {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(String(text || ''));
  return block ? [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => unxml(match[1])) : null;
}
// `launchctl print gui/<uid>/<label>` lists the program arguments one per line inside "arguments = { ... }".
export function launchctlArguments(text) {
  const block = /(?:^|\n)[ \t]*arguments = \{\r?\n([\s\S]*?)\r?\n[ \t]*\}/.exec(String(text || ''));
  return block ? block[1].split(/\r?\n/).map(line => line.trim()).filter(Boolean) : null;
}
// Exactly `node <our monitor> --config <our configuration>`: the program itself must be node, not merely be followed by our paths.
const monitorArguments = (list, at) => Array.isArray(list) && list.length === 4 && /^node$/i.test(path.basename(String(list[0]))) && path.isAbsolute(String(list[0])) && samePath(list[1], at.supervisor) && list[2] === '--config' && samePath(list[3], at.config);

const domain = () => `gui/${process.getuid?.() ?? 0}`;
// The job launchd has LOADED can differ from the file on disk (deleted or replaced plist).
// Returns the description of the loaded job, null when launchd says there is none (exit 113,
// "Could not find service"), and false when the question could not be answered (timeout, permission,
// anything else): unknown is never treated as absent.
function loadedAgent(run) {
  const result = run('launchctl', ['print', `${domain()}/${AGENT_LABEL}`], {encoding: 'utf8', timeout: 10000});
  if (result.status === 0) return String(result.stdout || '');
  return result.status === 113 && !result.error && /could not find service/i.test(String(result.stderr || '') + String(result.stdout || '')) ? null : false;
}

// 'ours' | 'other' | null
export function autostartOwner(at, {platform = process.platform, run = spawnSync, home = os.homedir(), read = fs.readFileSync, exists = fs.existsSync} = {}) {
  if (platform === 'win32') {
    const result = powershell(TASK_QUERY, run);
    return result.status === 0 ? taskOwner(result.stdout, at) : 'other';
  }
  if (platform !== 'darwin') return null;
  const file = exists(agentFile(home)) ? (monitorArguments(plistArguments(read(agentFile(home), 'utf8')), at) ? 'ours' : 'other') : null;
  const loaded = loadedAgent(run), job = loaded === null ? null : loaded !== false && monitorArguments(launchctlArguments(loaded), at) ? 'ours' : 'other';
  if (file === 'other' || job === 'other') return 'other';
  return file || job;
}

// Ask the login item to run the monitor now. False = caller starts it directly.
// Callers check autostartOwner(...) === 'ours' first.
export function kickAutostart(at, {platform = process.platform, run = spawnSync} = {}) {
  void at;
  if (platform === 'win32') return powershell(`Start-ScheduledTask -TaskName '${TASK_NAME}'`, run).status === 0;
  if (platform === 'darwin') return run('launchctl', ['kickstart', `${domain()}/${AGENT_LABEL}`], {timeout: 10000}).status === 0;
  return false;
}

export function enableAutostart(at, {platform = process.platform, run = spawnSync, home = os.homedir(), pathEnv = process.env.PATH || '', node = process.execPath} = {}) {
  if (!fs.existsSync(at.config)) throw new Error('Run `node aos.mjs start` once before enabling start-at-login.');
  if (autostartOwner(at, {platform, run, home}) === 'other') throw new Error('A different installation owns the recovery login item; nothing replaced.');
  if (platform === 'win32') {
    const result = powershell(scheduledTaskScript({node, config: at.config, wrapper: wrapperOf(at), cwd: at.root}), run);
    if (result.status !== 0) throw new Error('Windows refused the login task: ' + String(result.stderr || '').trim().slice(0, 300));
    return 'Windows login task installed.';
  }
  if (platform === 'darwin') {
    // Only a job proven to be ours (checked above) is ever unloaded.
    if (typeof loadedAgent(run) === 'string') run('launchctl', ['bootout', `${domain()}/${AGENT_LABEL}`], {timeout: 10000});
    fs.mkdirSync(path.dirname(agentFile(home)), {recursive: true});
    fs.writeFileSync(agentFile(home), launchAgentPlist({node, supervisor: at.supervisor, config: at.config, cwd: at.root, pathEnv, log: path.join(at.runtime, 'service-supervisor-startup-error.log')}));
    // Loading runs the job; while the pause marker is present the monitor exits at once and launchd leaves it.
    const loaded = run('launchctl', ['bootstrap', domain(), agentFile(home)], {encoding: 'utf8', timeout: 10000});
    if (loaded.status !== 0 && run('launchctl', ['load', '-w', agentFile(home)], {timeout: 10000}).status !== 0) throw new Error('launchctl refused the login item: ' + String(loaded.stderr || '').trim().slice(0, 300));
    return 'macOS login item installed.';
  }
  throw new Error('Start-at-login is available on Windows and macOS. On Linux, run `node aos.mjs start` from your session startup.');
}

export function disableAutostart(at, {platform = process.platform, run = spawnSync, home = os.homedir()} = {}) {
  const owner = autostartOwner(at, {platform, run, home});
  if (owner === 'other') throw new Error('A different installation owns the recovery login item; nothing removed.');
  if (!owner) return 'No login item was installed.';
  if (platform === 'win32') {
    if (powershell(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false`, run).status !== 0) throw new Error('Windows refused to remove the login task.');
    return 'Windows login task removed. Running services were left alone.';
  }
  // Removing the file first means a later login cannot start it even if bootout fails.
  fs.rmSync(agentFile(home), {force: true});
  if (typeof loadedAgent(run) === 'string') run('launchctl', ['bootout', `${domain()}/${AGENT_LABEL}`], {timeout: 10000});
  return 'macOS login item removed. Its monitor was stopped, which pauses recovery; run `node aos.mjs start` to resume.';
}
