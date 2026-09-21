import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {TerminalManager, terminalSpec} from '../runner/terminals.mjs';
import {routeVoice} from '../runner/bridge-core.mjs';
import {localDate} from '../runner/brief-voice.mjs';
import {WORKER_SPOKEN_STYLE,ARTIFACT_HANDOFF_INSTRUCTIONS} from '../runner/spoken-answer.mjs';

const story = 'Fable solved a historical cipher using a newly verified decipherment.';
const request = 'Create a visual graphic about that story';
const noModel = () => assert.fail('This request must not call a model');

function fixture(t, provider) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-voice-resume-'));
 const directory = path.join(root, 'sessions'), processes = [], managers = [], updates = [];
 const selection = {provider, model: provider === 'codex' ? 'gpt-6-astra' : 'sonnet'};
 const spawn = (command, args, options) => {
  const proc = {pid: 12000 + processes.length, command, args, options, writes: [],
   onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
   write(text) { this.writes.push(text); }, resize() {}, kill() { this.killed = true; }};
  processes.push(proc); return proc;
 };
 const open = () => {
  const manager = new TerminalManager(root, {directory, spawn, schedule: () => ({unref() {}}), cancelSchedule() {}});
  managers.push(manager); return manager;
 };
 const manager = open();
 const report = `inbox/research/morning-intel/${localDate()}-intel.md`;
 fs.mkdirSync(path.dirname(path.join(root, report)), {recursive: true});
 fs.writeFileSync(path.join(root, report), `## Top Story\n${story}\n\n## AI News\nOther saved news.`);
 const complete = (task, turnId = 'initial', text = 'The original answer.', activeManager = manager) => {
  activeManager.accept(task.id, {type: task.provider === 'codex' ? 'complete' : 'Stop',
   sessionId: task.sessionId || crypto.randomUUID(), turnId, text, ts: Date.now()});
 };
 const saved = (fields = {}) => {
  const task = manager.start({selection, prompt: 'The original request must never replay.', ...fields});
  complete(task); manager.stop(task.id); return task;
 };
 const speak = (transcript, taskId, extra = {}, execute = noModel, activeManager = manager, signal) =>
  routeVoice(root, {id: crypto.randomUUID(), selection, transcript, terminalMode: true, workTarget: taskId, ...extra},
   signal, execute, activeManager, {resolveCli: () => ({command: 'fixture-cli', prefix: []}), updateCurrent: change => updates.push(change)});
 t.after(() => { for (const activeManager of managers) activeManager.close(); fs.rmSync(root, {recursive: true, force: true}); });
 return {root, directory, manager, processes, selection, report, complete, saved, speak, open, updates};
}

for (const provider of ['codex', 'claude']) {
 test(`${provider}: quick speech is prepared before client formatting without changing its written answer or adding model calls`, async t => {
  const f=fixture(t,provider),reply='Here are the results.\n\n## Details\n\n| Name | Value |\n| --- | --- |\n| Progress | 42 |';let calls=0;
  const result=await f.speak('How should I think about evaluating source reliability?',null,{},async()=>{calls++;return {text:JSON.stringify({tier:2,reply})}});
  assert.equal(calls,1);assert.equal(result.reply,reply);assert.equal(result.spokenReply,'Here are the results.');assert.equal(f.processes.length,0);
 });
 test(`${provider}: saved news followed by graphic work resumes one existing session with its context and no readiness turn`, async t => {
  const f = fixture(t, provider), task = f.saved(), sessionId = task.sessionId;
  const quick = await f.speak('What was the top news in AI today?', task.id);
  assert.deepEqual(quick.workIds, []); assert.equal(quick.model, null); assert.equal(f.processes.length, 1);
  assert.ok(quick.reply.includes(story)); assert.equal(task.state, 'stopped');
  const id = crypto.randomUUID(), result = await f.speak(request, task.id, {id});
  assert.deepEqual(result.workIds, [task.id]); assert.equal(result.workerModel, task.model);
  assert.equal(task.sessionId, sessionId); assert.equal(task.provider, provider);
  assert.equal(f.manager.records.size, 1); assert.equal(f.processes.length, 2);
  const resumed = f.processes[1], prompt = resumed.args.at(-1);
  assert.ok(resumed.args.includes(sessionId)); assert.ok(resumed.args.includes(task.model));
  assert.ok(prompt.startsWith(request)); assert.ok(prompt.includes(story)); assert.ok(prompt.includes(f.report));
  assert.doesNotMatch(prompt, /Briefly confirm you are ready|The original request must never replay/);
  assert.deepEqual(resumed.writes, []); assert.equal(task.state, 'working');
  assert.equal(resumed.options.env.AOS_WORK_SESSION, sessionId);
  assert.equal(resumed.options.env.AOS_WORK_PROMPT, prompt);
  assert.deepEqual(f.updates, [{scope:'web',provider, id: task.id}]);
  const replay = await f.speak(request, task.id, {id});
  assert.deepEqual(replay, result); assert.equal(f.processes.length, 2); assert.deepEqual(resumed.writes, []);
  assert.equal(f.updates.length, 1);
 });

 test(`${provider}: naturally worded graphic follow-up keeps the brief after classification`, async t => {
  const f = fixture(t, provider), task = f.saved();
  await f.speak('What was the top news in AI today?', task.id);
  let modelCalls = 0;
  const utterance = 'Are you able to give me some sort of visual graphic about it?';
  await f.speak(utterance, task.id, {}, async (_root, _job, _prompt, options) => {
   modelCalls++; assert.ok(options.system.includes(story));
   return {text: '{"tier":3,"reply":"Creating the graphic."}'};
  });
  assert.equal(modelCalls, 1); assert.equal(f.processes.length, 2);
  assert.ok(f.processes[1].args.at(-1).startsWith(utterance)); assert.ok(f.processes[1].args.at(-1).includes(story));
 });

 test(`${provider}: existing live ready session uses one normal send, preserving its model`, async t => {
  const f = fixture(t, provider), task = f.manager.start({selection: {provider, model: provider === 'codex' ? 'gpt-5.6-luna' : 'opus'}, prompt: 'Original'});
  f.complete(task);
  const result = await f.speak(request, task.id);
  assert.equal(result.workerModel, task.model); assert.equal(f.processes.length, 1);
  assert.equal(f.processes[0].writes.length,1);assert.ok(f.processes[0].writes[0].startsWith(`\x1b[200~${request}\n\n${WORKER_SPOKEN_STYLE}\n\n${ARTIFACT_HANDOFF_INSTRUCTIONS}`));assert.ok(f.processes[0].writes[0].endsWith('\x1b[201~'));
 });

 test(`${provider}: voice resume cannot overwrite busy, editing, approval, or exiting terminals`, async t => {
  const f = fixture(t, provider);
  for (const state of ['working', 'starting', 'editing', 'needs input', 'stopping', 'error']) {
   const task = f.manager.start({selection: f.selection, prompt: `Protect ${state}`});
   f.complete(task); task.state = state;
   if (state === 'needs input') task.error = 'Waiting for your approval.';
   const before = f.processes.length;
   await assert.rejects(f.speak(request, task.id));
   assert.equal(f.processes.length, before); assert.deepEqual(f.processes.at(-1).writes, []);
   assert.equal(task.state, state);
  }
  const draft = f.manager.start({selection: f.selection, prompt: 'Protect unreported draft'}); f.complete(draft);
  f.manager.live.get(draft.id).inputBoundary.update('My unfinished draft');
  await assert.rejects(f.speak(request, draft.id)); assert.deepEqual(f.processes.at(-1).writes, []);
  const exiting = f.manager.start({selection: f.selection, prompt: 'Protect cleanup'}); f.complete(exiting);
  f.manager.live.get(exiting.id).exitObserved = true;
  const before = f.processes.length;
  await assert.rejects(f.speak(request, exiting.id));
  assert.equal(f.processes.length, before); assert.deepEqual(f.processes.at(-1).writes, []);
 });

 test(`${provider}: missing, unsaved, script, and foreign targets never become replacement conversations`, async t => {
  const f = fixture(t, provider);
  const unsaved = f.manager.start({selection: f.selection, prompt: 'No saved session yet'}); f.manager.stop(unsaved.id);
  const script = f.saved(); script.execution = 'script';
  const foreign = f.saved({selection: provider === 'codex' ? {provider: 'claude', model: 'sonnet'} : {provider: 'codex', model: 'gpt-6-astra'}});
  const count = f.processes.length;
  for (const id of [crypto.randomUUID(), unsaved.id, script.id, foreign.id]) await assert.rejects(f.speak(request, id));
  assert.equal(f.processes.length, count); assert.equal(f.updates.length, 0); assert.equal(f.manager.live.size, 0);
  assert.equal(f.manager.originalRequest(unsaved.id).prompt, 'No saved session yet');
 });

 test(`${provider}: bridge restart and quick lookups do not resume saved work, but a fresh work request does`, async t => {
  const f = fixture(t, provider), task = f.saved(), sessionId = task.sessionId;
  f.manager.close(); const reopened = f.open();
  assert.equal(f.processes.length, 1); assert.equal(reopened.live.size, 0); assert.equal(reopened.get(task.id).state, 'stopped');
  await f.speak('What was the top news in AI today?', task.id, {}, noModel, reopened);
  assert.equal(f.processes.length, 1); assert.equal(reopened.live.size, 0);
  await f.speak(request, task.id, {}, noModel, reopened);
  assert.equal(f.processes.length, 2); assert.equal(reopened.get(task.id).sessionId, sessionId);
 });

 test(`${provider}: cancelled voice work and invalid resume text do not reopen the stopped session`, async t => {
  const f = fixture(t, provider), task = f.saved(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.speak(request, task.id, {}, noModel, f.manager, controller.signal), /cancelled/);
  assert.throws(() => f.manager.send(task.id, 'Bad\x1b[201~\rinput', {resumeStopped: true}), /Control/);
  assert.throws(() => terminalSpec(f.root, task, {command: 'fixture-cli', prefix: []}, {resumePrompt: 'Bad\x1binput'}), /Control/);
  assert.equal(f.processes.length, 1); assert.equal(task.state, 'stopped'); assert.equal(f.updates.length, 0);
 });

 test(`${provider}: manual send keeps the resume gate, and manual resume retains its readiness-only prompt`, t => {
  const f = fixture(t, provider), task = f.saved();
  assert.throws(() => f.manager.send(task.id, request), /Resume/);
  f.manager.resume(task.id);
  assert.equal(f.processes.length, 2); assert.match(f.processes[1].args.at(-1), /without using tools or taking actions/);
  assert.deepEqual(f.processes[1].writes, []);
 });

 test(`${provider}: stopped completed workflow resumes into the next workflow and saves its first real result`, async t => {
  const f = fixture(t, provider), task = f.manager.startWorkflow({selection: f.selection, skill: 'inbox-brief'});
  f.complete(task, 'old-workflow', '# Original inbox brief\nSaved original output.');
  const oldPath = task.resultPath, oldText = fs.readFileSync(path.join(f.root, oldPath), 'utf8'), sessionId = task.sessionId;
  f.manager.stop(task.id);
  const id = crypto.randomUUID(), result = await f.speak('Run the weekly review', task.id, {id});
  assert.deepEqual(result.workIds, [task.id]); assert.equal(f.processes.length, 2);
  assert.ok(f.processes[1].args.at(-1).includes(`system/v2/task-instructions/${id}.md`));
  assert.equal(task.sessionId, sessionId); assert.equal(task.workflow.job.id, id);
  assert.equal(task.workflowCompleted, false); assert.deepEqual(f.processes[1].writes, []);
  const pending = JSON.stringify(task);
  f.manager.accept(task.id, {type: provider === 'codex' ? 'complete' : 'Stop', sessionId, turnId: 'old-workflow', text: '# Old replay', ts: Date.now()});
  f.manager.accept(task.id, {type: provider === 'codex' ? 'complete' : 'Stop', sessionId, turnId: 'unseen-stale-turn', text: '# Stale result', ts: task.workflow.startedAt - 1});
  assert.equal(JSON.stringify(task), pending);
  assert.equal(fs.existsSync(path.join(f.root, 'system/v2/artifacts', `${id}.md`)), false);
  const answer = '# New weekly review\nVerified first result after resuming.';
  f.complete(task, 'new-workflow', answer);
  assert.equal(task.workflowCompleted, true); assert.equal(task.workflowStatus, 'ok');
  assert.equal(fs.readFileSync(path.join(f.root, 'system/v2/artifacts', `${id}.md`), 'utf8'), answer);
  assert.equal(fs.readFileSync(path.join(f.root, oldPath), 'utf8'), oldText);
  const run = JSON.parse(fs.readFileSync(path.join(f.root, 'system/v2/runs', `${id}.json`), 'utf8'));
  assert.equal(run.task_id, task.id); assert.equal(run.status, 'ok'); assert.equal(run.model, task.model);
  await f.speak('Run the weekly review', task.id, {id}); assert.equal(f.processes.length, 2);
 });

 test(`${provider}: voice cannot replace a stopped unfinished workflow with another workflow`, async t => {
  const f = fixture(t, provider), task = f.saved();
  f.manager.resume(task.id); f.complete(task, 'ready-after-resume');
  f.manager.continueWorkflow(task.id, {selection: f.selection, skill: 'inbox-brief'}); f.manager.stop(task.id);
  const prior = JSON.stringify(task), count = f.processes.length, id = crypto.randomUUID();
  await assert.rejects(f.speak('Run the weekly review', task.id, {id}), /unfinished workflow/);
  assert.equal(JSON.stringify(task), prior); assert.equal(f.processes.length, count);
  assert.equal(fs.existsSync(path.join(f.root, 'system/v2/task-instructions', `${id}.md`)), false);
 });

 test(`${provider}: draining a stopped process cannot save its late result or revive its old approval`, async t => {
  const f = fixture(t, provider), task = f.manager.startWorkflow({selection: f.selection, skill: 'inbox-brief'});
  task.sessionId = crypto.randomUUID(); f.manager.stop(task.id);
  const artifact = path.join(f.root, 'system/v2/artifacts', `${task.id}.md`);
  const destination = path.join(f.root, task.workflow.destination), events = path.join(f.manager.folder(task.id), 'events');
  const oldCompletion = {type: provider === 'codex' ? 'complete' : 'Stop', sessionId: task.sessionId,
   turnId: 'late-cancelled-turn', text: '# Canceled late inbox result', ts: Date.now() - 1000};
  fs.writeFileSync(path.join(events, 'old-completion.json'), JSON.stringify(oldCompletion));
  fs.writeFileSync(path.join(events, 'old-permission.json'), JSON.stringify({type: 'PermissionRequest', sessionId: task.sessionId, ts: Date.now() - 500}));
  await f.speak(request, task.id);
  assert.equal(f.processes.length, 2); assert.equal(task.state, 'working'); assert.equal(task.error, null);
  assert.equal(task.workflowCompleted, undefined); assert.equal(task.turns.length, 0);
  assert.equal(fs.existsSync(artifact), false); assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readdirSync(events).filter(file => file.endsWith('.json')).length, 0);
  // Even if that old notification is delivered again after the new process
  // starts, its remembered identity cannot complete the new turn.
  f.manager.accept(task.id, {...oldCompletion, ts: Date.now() + 1});
  assert.equal(task.state, 'working'); assert.equal(task.turns.length, 0);
  assert.equal(fs.existsSync(artifact), false); assert.equal(fs.existsSync(destination), false);
 });
}
