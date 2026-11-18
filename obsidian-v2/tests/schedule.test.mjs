import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateSchedule, readSchedule, saveSchedule, editSchedule, scheduleRevision, readScheduleState, dueJobs, nextRun, localParts, scheduledMoment, scheduledTaskId, scheduleTick, scheduleView, schedulableSkills, DAYS, MAX_JOBS, SCHEDULE_FILE, SCHEDULE_STATE_FILE} from '../runner/schedule.mjs';
import {withFileLock} from '../runner/file-lock.mjs';
import {workId} from '../runner/terminals.mjs';
import {scheduleCommand, SCHEDULE_HELP} from '../scripts/aos/schedule.mjs';
import {layout} from '../scripts/aos/services.mjs';
import {main} from '../scripts/aos.mjs';
import {SKILLS} from '../shared/contract.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-schedule-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
const vault = schedule => { const root = fs.mkdtempSync(path.join(scratch, 'vault-')); if (schedule !== undefined) { fs.mkdirSync(path.join(root, 'system', 'v2'), {recursive: true}); fs.writeFileSync(path.join(root, SCHEDULE_FILE), typeof schedule === 'string' ? schedule : JSON.stringify(schedule)); } return root; };
// A fixed clock: Wednesday 18 November 2026 in Chicago (UTC-6).
const ZONE = 'America/Chicago', at = (hour, minute = 0, day = 18) => Date.UTC(2026, 10, day, hour + 6, minute);
const weekdayPlan = {skill: 'plan-today', at: '07:00', days: ['mon', 'tue', 'wed', 'thu', 'fri']};

test('a schedule holds bundled workflows that need no input, at real times, on real days', () => {
  const valid = validateSchedule({jobs: [weekdayPlan, {skill: 'morning-intel', at: '06:30'}]});
  assert.deepEqual(valid, {version: 1, paused: false, jobs: [
    {id: 'plan-today-0700', skill: 'plan-today', at: '07:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], enabled: true},
    {id: 'morning-intel-0630', skill: 'morning-intel', at: '06:30', days: [...DAYS], enabled: true}]}, 'no days means every day');
  assert.deepEqual(validateSchedule({}), {version: 1, paused: false, jobs: []});
  for (const [input, message] of [
    [null, /must be an object/], [{jobs: 'plan-today'}, /must be a list/],
    [{jobs: [{skill: 'rm-rf', at: '07:00'}]}, /not a bundled workflow/], [{jobs: [{skill: 'constructor', at: '07:00'}]}, /not a bundled workflow/],
    [{jobs: [{skill: 'deep-research-chase', at: '07:00'}]}, /needs a topic each time/],
    [{jobs: [{skill: 'plan-today', at: '7am'}]}, /not a time/], [{jobs: [{skill: 'plan-today', at: '24:00'}]}, /not a time/],
    [{jobs: [{skill: 'plan-today', at: '07:00', days: ['funday']}]}, /Days must be from/],
    [{jobs: [weekdayPlan, weekdayPlan]}, /same workflow at the same time/],
    // Anything written explicitly must be right: a slip must never widen what runs unattended.
    [{paused: 'true', jobs: [weekdayPlan]}, /"paused" takes true or false/], [{jobs: [{...weekdayPlan, days: []}]}, /at least one day/], [{jobs: [{...weekdayPlan, days: 'mon'}]}, /at least one day/],
    [{jobs: [{...weekdayPlan, enabled: 'no'}]}, /"enabled" takes true or false/], [{jobs: [[]]}, /not an object/],
    // A key the schedule does not know is a slip ("enable" for "enabled"), never quietly ignored.
    [{jobs: [{...weekdayPlan, enable: false}]}, /"enable" is not something a scheduled item understands/], [{pause: true, jobs: []}, /"pause" is not something the schedule understands/],
    // The same workflow at the same time on a shared day is one run, whatever the entries are called.
    [{jobs: [{...weekdayPlan, id: 'morning-plan'}, {...weekdayPlan, id: 'second-plan', days: ['fri', 'sat']}]}, /Plan Today at 07:00 is on the schedule twice for the same day/],
    [{jobs: Array.from({length: MAX_JOBS + 1}, (_, index) => ({skill: 'plan-today', at: `0${index % 10}:${String(index).padStart(2, '0')}`}))}, /12 items at most/]])
    assert.throws(() => validateSchedule(input), message);
  const skills = schedulableSkills().map(skill => skill.id);
  assert.ok(skills.includes('plan-today') && skills.includes('morning-intel'));
  for (const id of skills) assert.equal(SKILLS[id].arg, undefined, `${id} needs nothing typed in`);
});

test('nothing runs from a schedule that cannot be understood', () => {
  assert.deepEqual(readSchedule(vault()), {version: 1, paused: false, jobs: [], revision: 'none'}, 'no file means nothing scheduled');
  const broken = readSchedule(vault('{"jobs": ['));
  assert.deepEqual(broken.jobs, []); assert.match(broken.error, /cannot be read as a schedule .* so nothing is scheduled/);
  const half = readSchedule(vault({jobs: [weekdayPlan, {skill: 'plan-today', at: 'noon'}]}));
  assert.deepEqual(half.jobs, [], 'one bad entry stops the whole schedule rather than running half of it'); assert.match(half.error, /not a time/);
  assert.deepEqual(dueJobs(half, {last: {}}, at(8), {timeZone: ZONE}), []);
  const root = vault(), launched = [];
  fs.mkdirSync(path.join(root, 'system', 'v2'), {recursive: true}); fs.writeFileSync(path.join(root, SCHEDULE_FILE), 'garbage');
  assert.deepEqual(scheduleTick(root, job => launched.push(job), {now: at(8), timeZone: ZONE}), []);
  assert.deepEqual(launched, []);
});

test('a job runs once on its day at or after its time, and never twice', () => {
  const schedule = validateSchedule({jobs: [weekdayPlan]}), empty = {last: {}};
  assert.deepEqual(localParts(at(7, 5), ZONE), {date: '2026-11-18', day: 'wed', minutes: 425});
  assert.deepEqual(dueJobs(schedule, empty, at(6, 59), {timeZone: ZONE}), [], 'not before its time');
  assert.deepEqual(dueJobs(schedule, empty, at(7, 0), {timeZone: ZONE}).map(due => [due.job.id, due.date, due.missed]), [['plan-today-0700', '2026-11-18', false]]);
  assert.deepEqual(dueJobs(schedule, {last: {'plan-today-0700': {date: '2026-11-18'}}}, at(7, 30), {timeZone: ZONE}), [], 'already ran today');
  assert.equal(dueJobs(schedule, {last: {'plan-today-0700': {date: '2026-11-17'}}}, at(7, 30), {timeZone: ZONE}).length, 1, 'yesterday\'s run does not count for today');
  assert.deepEqual(dueJobs(schedule, empty, at(9, 0, 21), {timeZone: ZONE}), [], 'not on Saturday');
  assert.deepEqual(dueJobs({...schedule, paused: true}, empty, at(7, 30), {timeZone: ZONE}), []);
  assert.deepEqual(dueJobs(validateSchedule({jobs: [{...weekdayPlan, enabled: false}]}), empty, at(7, 30), {timeZone: ZONE}), []);
  // The same instant is a different local time, and a different day, elsewhere.
  assert.deepEqual(localParts(at(7, 30), 'Pacific/Auckland'), {date: '2026-11-19', day: 'thu', minutes: 150});
  assert.deepEqual(dueJobs(schedule, empty, at(7, 30), {timeZone: 'Pacific/Auckland'}), [], 'half past two in the morning there: not yet');
});

test('services that were off are caught up the same day within three hours, and not after', () => {
  const schedule = validateSchedule({jobs: [weekdayPlan]}), empty = {last: {}};
  assert.equal(dueJobs(schedule, empty, at(9, 59), {timeZone: ZONE})[0].missed, false, 'two hours 59 late still runs');
  assert.equal(dueJobs(schedule, empty, at(10, 0), {timeZone: ZONE})[0].missed, false);
  assert.equal(dueJobs(schedule, empty, at(10, 1), {timeZone: ZONE})[0].missed, true, 'a morning plan in the afternoon helps nobody');
  // Off for three days: only today's run is considered, never one per missed day.
  assert.equal(dueJobs(schedule, {last: {'plan-today-0700': {date: '2026-11-13'}}}, at(8), {timeZone: ZONE}).length, 1);
});

test('the bridge\'s look at the clock starts the workflow once, and records a miss or a failure without retrying', () => {
  const root = vault({jobs: [weekdayPlan, {skill: 'morning-intel', at: '06:30'}]}), launched = [];
  const ids = [];
  const launch = (job, id) => { launched.push(job.skill); ids.push(id); if (job.skill === 'morning-intel') throw new Error('Another task is updating that same note.'); return {id}; };
  assert.deepEqual(scheduleTick(root, launch, {now: at(6, 0), timeZone: ZONE}), []);
  assert.deepEqual(scheduleTick(root, launch, {now: at(7, 0), timeZone: ZONE}).map(item => [item.id, item.outcome]), [['plan-today-0700', 'started'], ['morning-intel-0630', 'failed']]);
  assert.deepEqual(launched, ['plan-today', 'morning-intel']);
  for (const minute of [1, 2, 30]) assert.deepEqual(scheduleTick(root, launch, {now: at(7, minute), timeZone: ZONE}), [], 'nothing is retried the same day');
  assert.deepEqual(launched, ['plan-today', 'morning-intel']);
  const state = readScheduleState(root);
  assert.equal(state.last['plan-today-0700'].outcome, 'started');
  assert.equal(state.last['plan-today-0700'].taskId, scheduledTaskId('plan-today-0700', '2026-11-18', root));
  assert.deepEqual(ids, [scheduledTaskId('plan-today-0700', '2026-11-18', root), scheduledTaskId('morning-intel-0630', '2026-11-18', root)], 'each run is given its own fixed task ID');
  assert.ok(ids.every(workId), 'in the shape the workflow starter accepts');
  assert.match(state.last['morning-intel-0630'].detail, /Another task is updating/);
  assert.equal(state.history.length, 2);
  // The next day both run again; a start in the afternoon records a miss and launches nothing.
  assert.equal(scheduleTick(root, launch, {now: at(7, 0, 19), timeZone: ZONE}).length, 2);
  const late = scheduleTick(root, () => assert.fail('a missed run is not launched'), {now: at(15, 0, 20), timeZone: ZONE});
  assert.deepEqual(late.map(item => item.outcome), ['missed', 'missed']);
  assert.match(readScheduleState(root).last['plan-today-0700'].detail, /services were not running at 07:00/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'system', 'v2')).sort(), ['schedule-state.json', 'schedule.json'], 'no temporary files are left behind');
  // A launch that throws something odd, or an unwritable state, never throws out of the tick.
  assert.doesNotThrow(() => scheduleTick(vault({jobs: [weekdayPlan]}), () => { throw null; }, {now: at(7), timeZone: ZONE}));
  assert.equal(SCHEDULE_STATE_FILE, 'system/v2/schedule-state.json');
});

test('a workflow can never be started twice for the same day', () => {
  // The same job and day always give the same task ID; another day or another job gives another.
  assert.equal(scheduledTaskId('plan-today-0700', '2026-11-18'), scheduledTaskId('plan-today-0700', '2026-11-18'));
  assert.notEqual(scheduledTaskId('plan-today-0700', '2026-11-18'), scheduledTaskId('plan-today-0700', '2026-11-19'));
  assert.notEqual(scheduledTaskId('plan-today-0700', '2026-11-18'), scheduledTaskId('morning-intel-0630', '2026-11-18'));
  // One installation pointed at a second vault must not find the first vault's run under the same ID.
  assert.notEqual(scheduledTaskId('plan-today-0700', '2026-11-18', '/vaults/a'), scheduledTaskId('plan-today-0700', '2026-11-18', '/vaults/b'));
  assert.equal(scheduledTaskId('plan-today-0700', '2026-11-18', '/vaults/a'), scheduledTaskId('plan-today-0700', '2026-11-18', '/vaults/a/'), 'the same folder written with a trailing slash is the same vault');
  assert.notEqual(scheduledTaskId('plan-today-0700', '2026-11-18', '/vaults/Work'), scheduledTaskId('plan-today-0700', '2026-11-18', '/vaults/work'), 'on a Mac two vaults can differ only by capitals');

  // The run is written down BEFORE the workflow starts: a bridge that dies inside the start finds its own
  // note at the next look and starts nothing.
  const crashed = vault({jobs: [weekdayPlan]});
  let seenDuringLaunch = null;
  assert.throws(() => { try { scheduleTick(crashed, () => { seenDuringLaunch = readScheduleState(crashed).last['plan-today-0700']; process.emitWarning = process.emitWarning; throw Object.assign(new Error('crash'), {fatal: true}); }, {now: at(7), timeZone: ZONE}); } finally { fs.writeFileSync(path.join(crashed, SCHEDULE_STATE_FILE), JSON.stringify({version: 1, last: {'plan-today-0700': seenDuringLaunch}, history: []})); } throw new Error('bridge died here'); }, /bridge died here/);
  assert.equal(seenDuringLaunch.outcome, 'starting'); assert.equal(seenDuringLaunch.date, '2026-11-18');
  assert.deepEqual(scheduleTick(crashed, () => assert.fail('a run that was already being started is not started again'), {now: at(7, 1), timeZone: ZONE}), []);

  // The record cannot be saved (here: the place for it is taken by a folder): nothing is started at all.
  const unwritable = vault({jobs: [weekdayPlan]});
  fs.mkdirSync(path.join(unwritable, SCHEDULE_STATE_FILE));
  assert.deepEqual(scheduleTick(unwritable, () => assert.fail('never start what cannot be written down'), {now: at(7), timeZone: ZONE}), []);

  // The record exists but cannot be read: whether today's run happened is unknown, so nothing runs, and the listing says so.
  const unreadable = vault({jobs: [weekdayPlan]});
  fs.writeFileSync(path.join(unreadable, SCHEDULE_STATE_FILE), '{"last": ');
  assert.equal(readScheduleState(unreadable).unreadable, true);
  for (const minute of [0, 1, 30]) assert.deepEqual(scheduleTick(unreadable, () => assert.fail('never start on an unreadable record'), {now: at(7, minute), timeZone: ZONE}), []);
  assert.match(scheduleView(unreadable, {now: at(7), timeZone: ZONE}).error, /schedule-state\.json cannot be read, so nothing will run/);
  assert.equal(scheduleView(unreadable, {now: at(7), timeZone: ZONE}).jobs[0].next, 'not running');
});

test('on the days the clocks change, the catch-up window is three hours of real time', () => {
  // Chicago, 1 November 2026: 02:00 happens twice. Midnight local is 05:00 UTC; the first 01:30 is 06:30 UTC.
  const fall = (hour, minute = 0) => Date.UTC(2026, 10, 1, hour, minute);
  assert.equal(scheduledMoment('00:30', fall(9, 15), ZONE), fall(5, 30));
  assert.equal(scheduledMoment('01:30', fall(9, 15), ZONE), fall(6, 30), 'a time that happens twice means the first one');
  const early = validateSchedule({jobs: [{skill: 'plan-today', at: '00:30'}]});
  // 03:15 on the clock is 3 hours 45 minutes after 00:30 that night, not 2 hours 45.
  assert.deepEqual(localParts(fall(9, 15), ZONE), {date: '2026-11-01', day: 'sun', minutes: 195});
  assert.equal(dueJobs(early, {last: {}}, fall(9, 15), {timeZone: ZONE})[0].missed, true);
  assert.equal(dueJobs(early, {last: {}}, fall(8, 30), {timeZone: ZONE})[0].missed, false, 'exactly three hours later');
  // Chicago, 8 March 2026: 02:00 to 03:00 does not exist. 01:30 local is 07:30 UTC; 05:00 local is 10:00 UTC.
  const spring = (hour, minute = 0) => Date.UTC(2026, 2, 8, hour, minute);
  const night = validateSchedule({jobs: [{skill: 'plan-today', at: '01:30'}]});
  assert.equal(scheduledMoment('01:30', spring(10), ZONE), spring(7, 30));
  assert.equal(dueJobs(night, {last: {}}, spring(10), {timeZone: ZONE})[0].missed, false, 'only two and a half real hours have passed at 05:00');
  // A time the clocks skip still runs once, when they jump past it.
  const skipped = validateSchedule({jobs: [{skill: 'plan-today', at: '02:30'}]});
  assert.deepEqual(dueJobs(skipped, {last: {}}, spring(7, 59), {timeZone: ZONE}), [], '01:59: not yet');
  assert.equal(dueJobs(skipped, {last: {}}, spring(8, 0), {timeZone: ZONE}).length, 1, '03:00: the skipped time has passed');
  // The skipped time means the same moment whenever it is asked, before the jump or long after it...
  assert.equal(scheduledMoment('02:30', spring(7, 30), ZONE), spring(8, 0));
  assert.equal(scheduledMoment('02:30', spring(11, 45), ZONE), spring(8, 0));
  // ...so a restart at 05:45 (two hours 45 after the jump) still catches it up.
  assert.equal(dueJobs(skipped, {last: {}}, spring(10, 45), {timeZone: ZONE})[0].missed, false);
  assert.equal(dueJobs(skipped, {last: {}}, spring(11, 1), {timeZone: ZONE})[0].missed, true);
  // A zone whose clocks move by half an hour (Lord Howe Island, 5 April 2026: 02:00 becomes 01:30).
  // 01:45 happens twice there; the first is 14:45 UTC the day before, the second 15:15.
  assert.equal(scheduledMoment('01:45', Date.UTC(2026, 3, 4, 20), 'Australia/Lord_Howe'), Date.UTC(2026, 3, 4, 14, 45));
  // Just after and just before midnight, east and west of UTC.
  assert.equal(scheduledMoment('00:05', Date.UTC(2026, 10, 18, 3), 'Asia/Tokyo'), Date.UTC(2026, 10, 17, 15, 5));
  assert.equal(scheduledMoment('23:55', Date.UTC(2026, 10, 18, 3), 'Asia/Tokyo'), Date.UTC(2026, 10, 18, 14, 55));
  assert.equal(scheduledMoment('00:05', at(1), ZONE), at(0, 5));
  assert.equal(scheduledMoment('23:55', at(1), ZONE), at(23, 55));
  // An ordinary day is unchanged.
  assert.equal(scheduledMoment('07:00', at(9), ZONE), at(7));
});

test('two changes at once cannot undo each other, and a save from an old copy is refused', () => {
  const root = vault({jobs: [weekdayPlan]});
  // A pause that lands while an add is in progress survives: the add is applied to the file as it is then.
  const revision = scheduleRevision(root);
  editSchedule(root, schedule => ({...schedule, paused: true}));
  const added = editSchedule(root, schedule => ({...schedule, jobs: [...schedule.jobs, {skill: 'morning-intel', at: '06:30'}]}));
  assert.equal(added.paused, true); assert.equal(added.jobs.length, 2);
  // A screen still holding the first copy cannot write it back over both changes.
  assert.throws(() => editSchedule(root, () => ({jobs: [weekdayPlan]}), {revision}), /changed since it was loaded/);
  assert.equal(readSchedule(root).paused, true);
  assert.equal(editSchedule(root, schedule => ({...schedule, paused: false}), {revision: scheduleRevision(root)}).paused, false);
  assert.equal(scheduleRevision(vault()), 'none'); assert.equal(scheduleView(root, {now: at(6), timeZone: ZONE}).revision, scheduleRevision(root));
  // What a screen is shown and the revision it is given come from one read of the file: saving exactly
  // what was shown, with that revision, can only ever write back what the file already said.
  const shown = readSchedule(root);
  assert.equal(shown.revision, scheduleRevision(root)); assert.equal(typeof shown.paused, 'boolean');
  editSchedule(root, schedule => ({...schedule, paused: true}));
  assert.throws(() => editSchedule(root, () => ({paused: shown.paused, jobs: shown.jobs}), {revision: shown.revision}), /changed since it was loaded/);
  assert.equal(readSchedule(root).paused, true, 'the pause made in between survives');
  editSchedule(root, schedule => ({...schedule, paused: false}));
  // A change that turns out invalid leaves the file as it was, and the lock is released either way.
  const before = fs.readFileSync(path.join(root, SCHEDULE_FILE), 'utf8');
  assert.throws(() => editSchedule(root, schedule => ({...schedule, jobs: [{skill: 'nope', at: '07:00'}]})), /not a bundled workflow/);
  assert.equal(fs.readFileSync(path.join(root, SCHEDULE_FILE), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, SCHEDULE_FILE) + '.lock'), false);

  // The lock itself: a second writer waits, gives up with a sentence, and ignores a lock left by a dead program.
  const file = path.join(root, 'system', 'v2', 'locked.json'); let clock = 1000; const naps = [];
  fs.writeFileSync(file + '.lock', '');
  assert.throws(() => withFileLock(file, () => assert.fail('must not run while locked'), {waitMs: 100, staleMs: 1e12, now: () => clock, sleep: ms => { naps.push(ms); clock += ms; }}), /Another program is saving this setting right now/);
  assert.ok(naps.length >= 3, 'it waited before giving up');
  assert.equal(withFileLock(file, () => 'ran', {staleMs: -1}), 'ran', 'an old lock whose owner is not running belongs to a program that died');
  // A lock whose owner is still running is never taken over, however old it is: the owner may only be slow.
  fs.writeFileSync(file + '.lock', `${process.pid}:someone-else`);
  clock = 5000;
  assert.throws(() => withFileLock(file, () => assert.fail('must not push a live owner aside'), {waitMs: 100, staleMs: -1, now: () => clock, sleep: ms => { clock += ms; }}), /Another program is saving/);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), `${process.pid}:someone-else`, 'and its lock is left exactly as it was');
  // The same lock once its owner has gone is taken over.
  assert.equal(withFileLock(file, () => 'ran', {staleMs: -1, alive: () => false}), 'ran');
  // An owner removes only its own lock: one that was replaced while it worked is left for its new owner.
  withFileLock(file, () => { fs.writeFileSync(file + '.lock', '999999:successor'); });
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), '999999:successor');
  fs.rmSync(file + '.lock');
  // Waiting is bounded even when the lock can be neither read nor removed.
  fs.mkdirSync(file + '.lock'); clock = 0; let waits = 0;
  assert.throws(() => withFileLock(file, () => assert.fail('never'), {waitMs: 200, now: () => clock, sleep: ms => { waits++; clock += ms; }}));
  assert.ok(waits <= 20, 'it gave up instead of spinning');
  fs.rmdirSync(file + '.lock');
  assert.equal(fs.existsSync(file + '.lock'), false);
  assert.equal(withFileLock(file, () => withFileLock(file + '2', () => 'nested'), {}), 'nested');
});

test('a schedule behind a linked folder is refused', t => {
  const root = vault(), elsewhere = fs.mkdtempSync(path.join(scratch, 'elsewhere-'));
  fs.mkdirSync(path.join(root, 'system'), {recursive: true});
  try { fs.symlinkSync(elsewhere, path.join(root, 'system', 'v2'), 'junction'); } catch { t.skip('this computer does not allow creating a linked folder'); return; }
  fs.writeFileSync(path.join(elsewhere, 'schedule.json'), JSON.stringify({jobs: [weekdayPlan]}));
  assert.match(readSchedule(root).error, /behind a linked folder/);
  assert.deepEqual(scheduleTick(root, () => assert.fail('nothing runs from a linked folder'), {now: at(7), timeZone: ZONE}), []);
  assert.throws(() => saveSchedule(root, {jobs: [weekdayPlan]}), /Linked paths are not allowed/);
  assert.deepEqual(fs.readdirSync(elsewhere), ['schedule.json'], 'nothing was written through the link');
});

test('the listing says when each job runs next and how the last run went', () => {
  const schedule = validateSchedule({jobs: [weekdayPlan]}), job = schedule.jobs[0];
  assert.equal(nextRun(job, {last: {}}, at(6, 0), {timeZone: ZONE}), 'today 07:00');
  assert.equal(nextRun(job, {last: {'plan-today-0700': {date: '2026-11-18'}}}, at(8, 0), {timeZone: ZONE}), 'tomorrow 07:00');
  assert.equal(nextRun(job, {last: {}}, at(15, 0), {timeZone: ZONE}), 'tomorrow 07:00', 'too late for today');
  assert.equal(nextRun(job, {last: {}}, at(9, 0, 20), {timeZone: ZONE}), 'today 07:00', 'Friday morning, still within the catch-up window');
  assert.equal(nextRun(job, {last: {'plan-today-0700': {date: '2026-11-20'}}}, at(9, 0, 20), {timeZone: ZONE}), 'Mon 07:00', 'Friday done: Monday is next');
  assert.equal(nextRun({...job, enabled: false}, {last: {}}, at(6), {timeZone: ZONE}), 'off');
  const root = vault({jobs: [weekdayPlan]});
  scheduleTick(root, () => ({id: 'task-9'}), {now: at(7), timeZone: ZONE});
  const view = scheduleView(root, {now: at(8), timeZone: ZONE});
  assert.equal(view.jobs[0].label, 'Plan Today'); assert.equal(view.jobs[0].next, 'tomorrow 07:00'); assert.equal(view.jobs[0].last.outcome, 'started');
  assert.equal(view.history[0].id, 'plan-today-0700'); assert.equal(view.timeZone, ZONE);
});

test('the schedule command adds, lists, switches and removes, and explains a mistake', async () => {
  const root = path.join(fs.mkdtempSync(path.join(scratch, 'install-')), 'obsidian-v2'), home = layout(root), theVault = vault();
  const run = async (words, flags = {}) => { const lines = []; const code = await scheduleCommand({words, flags, log: line => lines.push(line), at: home, vault: theVault, now: at(6)}); return {code, text: lines.join('\n')}; };
  assert.match((await run([])).text, /Nothing is scheduled\. Example: node aos\.mjs schedule add plan-today 07:00 --days weekdays/);
  const added = await run(['add', 'plan-today', '07:00'], {days: 'weekdays'});
  assert.match(added.text, /Scheduled: Plan Today at 07:00, weekdays \(id plan-today-0700\)/);
  assert.match(added.text, /uses your Claude or Codex plan the same as pressing the button/);
  await run(['add', 'morning-intel', '06:30']);
  await run(['add', 'inbox-brief', '12:00'], {days: 'Mon,Wed,Friday'});
  assert.deepEqual(readSchedule(theVault).jobs.map(job => [job.id, job.days.length]), [['plan-today-0700', 5], ['morning-intel-0630', 7], ['inbox-brief-1200', 3]]);
  const listed = (await run([])).text;
  assert.match(listed, /plan-today-0700\s+Plan Today, 07:00 weekdays\s+next: today 07:00\s+last: has not run yet/);
  assert.match(listed, /inbox-brief-1200\s+Inbox Brief, 12:00 mon, wed, fri/);
  assert.match(listed, /Runs happen only while the services are running/);
  assert.match((await run(['off', 'morning-intel-0630'])).text, /morning-intel-0630 is off/);
  assert.match((await run([])).text, /morning-intel-0630.*\[off\]\s+next: off/);
  assert.match((await run(['pause'])).text, /Every scheduled run is paused/);
  assert.match((await run([])).text, /PAUSED/);
  await run(['resume']); await run(['on', 'morning-intel-0630']);
  assert.match((await run(['remove', 'inbox-brief-1200'])).text, /Removed inbox-brief-1200/);
  assert.deepEqual(readSchedule(theVault).jobs.map(job => job.id), ['plan-today-0700', 'morning-intel-0630']);
  assert.match((await run(['skills'])).text, /plan-today\s+Plan Today/);
  const before = fs.readFileSync(path.join(theVault, SCHEDULE_FILE), 'utf8');
  for (const [words, flags, message] of [[['add', 'plan-today'], {}, /schedule add <workflow> <HH:MM>/], [['add', 'plan-today', '07:00'], {}, /same workflow at the same time/], [['add', 'deep-research-chase', '07:00'], {}, /needs a topic/], [['add', 'plan-today', '8'], {}, /not a time/], [['add', 'plan-today', '08:00'], {days: 'someday'}, /--days takes/], [['remove', 'nope'], {}, /Nothing on the schedule is called "nope"/], [['on', 'nope'], {}, /Nothing on the schedule/]])
    await assert.rejects(run(words, flags), message, words.join(' '));
  assert.equal(fs.readFileSync(path.join(theVault, SCHEDULE_FILE), 'utf8'), before, 'a refused command changes nothing');
  const unknown = await run(['sometimes']); assert.equal(unknown.code, 1); assert.equal(unknown.text, SCHEDULE_HELP);
  // A schedule file someone broke by hand is reported, never overwritten by the next command.
  fs.writeFileSync(path.join(theVault, SCHEDULE_FILE), '{"jobs": [');
  await assert.rejects(run(['add', 'plan-today', '09:00']), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(theVault, SCHEDULE_FILE), 'utf8'), '{"jobs": [');
  assert.equal((await run([])).code, 1);
  const lines = []; await main(['help'], line => lines.push(line));
  assert.match(lines.join('\n'), /\n  schedule\s+run a workflow by itself at a set time/);
  // Whole day names only, and an option the command does not know is a slip.
  fs.writeFileSync(path.join(theVault, SCHEDULE_FILE), JSON.stringify({jobs: []}));
  await assert.rejects(run(['add', 'plan-today', '09:00'], {days: 'mondayish'}), /--days takes/);
  await assert.rejects(run(['add', 'plan-today', '09:00'], {day: 'weekdays'}), /--day is not an option of schedule add\. Did you mean --days\? Nothing was scheduled/);
  assert.deepEqual(readSchedule(theVault).jobs, []);
  await run(['add', 'plan-today', '09:00'], {days: 'Monday, wed'});
  assert.deepEqual(readSchedule(theVault).jobs[0].days, ['mon', 'wed']);
  // --days with nothing after it is a slip, not "every day".
  fs.writeFileSync(path.join(theVault, SCHEDULE_FILE), JSON.stringify({jobs: []}));
  await assert.rejects(run(['add', 'plan-today', '09:00'], {days: true}), /--days needs a value/);
  assert.deepEqual(readSchedule(theVault).jobs, []);
  assert.ok(saveSchedule(vault(), {jobs: [weekdayPlan]}).jobs.length === 1);
});

// The one read-only line both screens show under their dashboard buttons, bundled the way they bundle it.
test('the screens show what is scheduled in a line, and show nothing when they cannot tell', async () => {
  const {build} = await import('esbuild');
  const built = await build({entryPoints: ['shared/schedule-note.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
  const {scheduleLines, createScheduleNoteStore} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  const root = vault({jobs: [weekdayPlan, {skill: 'morning-intel', at: '06:30'}, {skill: 'inbox-brief', at: '12:00', days: ['mon', 'wed'], enabled: false}]});
  scheduleTick(root, job => { if (job.skill === 'morning-intel') throw new Error('busy'); }, {now: at(7), timeZone: ZONE});
  const view = scheduleView(root, {now: at(8), timeZone: ZONE});
  assert.deepEqual(scheduleLines(view), {error: '', lines: ['Plan Today 07:00 weekdays, next tomorrow 07:00', 'Intel Brief 06:30, next tomorrow 06:30, last run failed', 'Inbox Brief 12:00 mon, wed (off)']});
  editSchedule(root, schedule => ({...schedule, paused: true}));
  assert.equal(scheduleLines(scheduleView(root, {now: at(8), timeZone: ZONE})).lines[0], 'Plan Today 07:00 weekdays (paused)');
  assert.deepEqual(scheduleLines(scheduleView(vault(), {now: at(8), timeZone: ZONE})), {lines: [], error: ''}, 'nothing scheduled shows nothing');
  assert.match(scheduleLines(scheduleView(vault('{"jobs": ['), {now: at(8), timeZone: ZONE})).error, /nothing is scheduled/);
  for (const odd of [null, undefined, 'text', {error: 'Unknown route'}, {jobs: 'none'}, []]) assert.deepEqual(scheduleLines(odd), {lines: [], error: ''});
  // An older bridge, or one that is offline, leaves the line empty instead of showing an error.
  const old = createScheduleNoteStore(async () => ({status: 400, json: {error: 'Unknown route'}})); await old.refresh(); assert.deepEqual(old.getSnapshot(), {lines: [], error: ''});
  const down = createScheduleNoteStore(async () => { throw new Error('offline'); }); await down.refresh(); assert.deepEqual(down.getSnapshot(), {lines: [], error: ''});
  const live = createScheduleNoteStore(async route => ({status: 200, json: route === '/schedule' ? view : {}})); await live.refresh();
  assert.equal(live.getSnapshot().lines.length, 3);
  const first = live.getSnapshot(); await live.refresh(); assert.equal(live.getSnapshot(), first, 'an unchanged schedule does not redraw the screen');
  // A bridge that stops answering: the line is taken off the screen, not left there as if it were current.
  let up = true;
  const flaky = createScheduleNoteStore(async () => { if (!up) throw new Error('offline'); return {status: 200, json: view}; });
  await flaky.refresh(); assert.equal(flaky.getSnapshot().lines.length, 3);
  up = false; await flaky.refresh(); assert.deepEqual(flaky.getSnapshot(), {lines: [], error: ''});
  up = true; await flaky.refresh(); assert.equal(flaky.getSnapshot().lines.length, 3);
});
