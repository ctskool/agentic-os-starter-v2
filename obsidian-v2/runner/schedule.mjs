// Scheduled workflows: "run Plan Today at 7:00 on weekdays".
//
// Members only had buttons. A schedule runs the same background workflow a button runs, by itself, while
// the services are running. It is opt-in and empty by default, because an unattended run uses the member's
// Claude or Codex plan exactly as pressing the button does.
//
//   system/v2/schedule.json        what to run and when (edited by `node aos.mjs schedule`, or by hand)
//   system/v2/schedule-state.json  what ran, written by the bridge
//
// Rules that keep it predictable:
//   - one run per job per day, at or after its time, in the computer's own time zone
//   - the day's run is written down BEFORE the workflow is started, and its task has an ID made from the job
//     and the date, so a crash, a lost write or a second look at the clock can never start it twice
//   - if the services were off at that time, the run is caught up when they start, but only for today and
//     only within three hours of real elapsed time; later than that it is recorded as missed
//   - a run that cannot start (the same note is being updated, the coding tool is missing) is recorded as
//     failed and not retried until the next day
//   - only bundled workflows that need no extra input can be scheduled
//   - a schedule or a record that cannot be read runs nothing
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {SKILLS} from '../shared/contract.mjs';
import {TIME_ZONE} from '../shared/timezone.mjs';
import {vaultPath} from './core.mjs';
import {withFileLock} from './file-lock.mjs';

export const SCHEDULE_FILE = 'system/v2/schedule.json';
export const SCHEDULE_STATE_FILE = 'system/v2/schedule-state.json';
export const DAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
export const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri']);
export const MAX_JOBS = 12;
export const LATE_MINUTES = 180;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Inside the vault, and never through a linked folder: two vaults sharing one linked system folder would
// otherwise overwrite each other's schedule.
const inVault = (root, relative) => vaultPath(path.resolve(root), relative);

// The workflows a schedule may run: bundled ones that need nothing typed in.
export const schedulableSkills = () => Object.entries(SKILLS).filter(([, skill]) => !skill.arg).map(([id, skill]) => ({id, label: skill.label}));
const minutesOf = at => { const match = TIME.exec(at); return Number(match[1]) * 60 + Number(match[2]); };

// Throws with a sentence a person can act on; returns the schedule in its stored shape. Anything written
// explicitly must be right: a half-understood line must never widen what runs unattended.
export function validateSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The schedule must be an object.');
  const unknown = (value, allowed, where) => { const extra = Object.keys(value).find(key => !allowed.includes(key)); if (extra !== undefined) throw new Error(`"${String(extra).slice(0, 40)}" is not something ${where} understands. It knows: ${allowed.join(', ')}.`); };
  unknown(input, ['version', 'paused', 'jobs'], 'the schedule');
  if (input.paused !== undefined && typeof input.paused !== 'boolean') throw new Error('"paused" takes true or false.');
  if (input.jobs !== undefined && !Array.isArray(input.jobs)) throw new Error('"jobs" must be a list.');
  const jobs = (input.jobs ?? []).map((job, index) => {
    if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error(`Scheduled item ${index + 1} is not an object.`);
    unknown(job, ['id', 'skill', 'at', 'days', 'enabled'], 'a scheduled item');
    if (typeof job.skill !== 'string' || !Object.hasOwn(SKILLS, job.skill)) throw new Error(`"${String(job.skill).slice(0, 40)}" is not a bundled workflow. \`node aos.mjs schedule skills\` lists the ones that can be scheduled.`);
    if (SKILLS[job.skill].arg) throw new Error(`${SKILLS[job.skill].label} needs a ${SKILLS[job.skill].arg} each time, so it cannot run on a schedule.`);
    if (typeof job.at !== 'string' || !TIME.test(job.at)) throw new Error(`"${String(job.at).slice(0, 20)}" is not a time. Use 24-hour HH:MM, for example 07:00 or 18:30.`);
    if (job.days !== undefined && (!Array.isArray(job.days) || !job.days.length)) throw new Error('"days" must list at least one day, or be left out for every day.');
    const days = [...new Set(job.days ?? DAYS)];
    if (days.some(day => !DAYS.includes(day))) throw new Error(`Days must be from: ${DAYS.join(', ')}.`);
    if (job.enabled !== undefined && typeof job.enabled !== 'boolean') throw new Error('"enabled" takes true or false.');
    const id = typeof job.id === 'string' && /^[a-z0-9-]{3,60}$/.test(job.id) ? job.id : `${job.skill}-${job.at.replace(':', '')}`;
    return {id, skill: job.skill, at: job.at, days: DAYS.filter(day => days.includes(day)), enabled: job.enabled !== false};
  });
  if (jobs.length > MAX_JOBS) throw new Error(`A schedule holds ${MAX_JOBS} items at most.`);
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('Two scheduled items are the same workflow at the same time. Remove one.');
  // The same workflow at the same time on the same day is one run, whatever the two entries are called.
  for (const [index, job] of jobs.entries()) for (const other of jobs.slice(index + 1))
    if (job.skill === other.skill && job.at === other.at && job.days.some(day => other.days.includes(day))) throw new Error(`${SKILLS[job.skill].label} at ${job.at} is on the schedule twice for the same day. Remove one.`);
  return {version: 1, paused: input.paused === true, jobs};
}

const readText = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 1));
  try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch { /* nothing to remove */ } throw error; }
};

// No file means nothing is scheduled. A file that cannot be read or is not a valid schedule runs NOTHING
// and says why: a half-understood schedule must never start work. `revision` is a fingerprint of exactly the
// text this answer was made from ('none' when there is no file).
export function readSchedule(root) {
  let text;
  try { text = readText(inVault(root, SCHEDULE_FILE)); }
  catch (error) { return error.code === 'ENOENT' ? {version: 1, paused: false, jobs: [], revision: 'none'} : {version: 1, paused: false, jobs: [], revision: 'unreadable', error: 'system/v2/schedule.json cannot be read as a schedule (it is not valid JSON, or it is behind a linked folder), so nothing is scheduled. Fix it or remove it.'}; }
  const revision = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  let raw;
  try { raw = JSON.parse(text); } catch { return {version: 1, paused: false, jobs: [], revision, error: 'system/v2/schedule.json cannot be read as a schedule (it is not valid JSON, or it is behind a linked folder), so nothing is scheduled. Fix it or remove it.'}; }
  try { return {...validateSchedule(raw), revision}; } catch (error) { return {version: 1, paused: false, jobs: [], revision, error: `${String(error.message || error)} Nothing is scheduled until system/v2/schedule.json is fixed.`}; }
}
export const scheduleRevision = root => readSchedule(root).revision;
export function saveSchedule(root, schedule) { const valid = validateSchedule(schedule); atomicJson(inVault(root, SCHEDULE_FILE), valid); return valid; }
// Read, change and write back as one step, so two commands at once (an `add` and a `pause`, say) cannot
// undo each other. `change` gets the current schedule ({paused, jobs}) and returns the new one. A schedule
// that cannot be understood is never overwritten. `revision`, when given, must still match the file.
export function editSchedule(root, change, {revision} = {}) {
  return withFileLock(inVault(root, SCHEDULE_FILE), () => {
    const {revision: now, error, ...current} = readSchedule(root);
    if (revision !== undefined && revision !== now) throw new Error('The schedule changed since it was loaded. Reload it and try again.');
    if (error) throw new Error(error);
    return saveSchedule(root, change(current));
  });
}

// {last, history} or, when the record exists but cannot be read, {unreadable: true}: then nothing runs,
// because "did it already run today?" has no answer.
export function readScheduleState(root) {
  let text;
  try { text = readText(inVault(root, SCHEDULE_STATE_FILE)); } catch (error) { return error.code === 'ENOENT' ? {version: 1, last: {}, history: []} : {unreadable: true, last: {}, history: []}; }
  try { const state = JSON.parse(text); if (state && typeof state.last === 'object' && state.last && !Array.isArray(state.last)) return {version: 1, last: state.last, history: Array.isArray(state.history) ? state.history.slice(-40) : []}; } catch { /* falls through */ }
  return {unreadable: true, last: {}, history: []};
}

// The date, weekday and minute of the day as the computer's own clock shows them.
const formatters = new Map();
const formatterFor = timeZone => {
  let formatter = formatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit'}); formatters.set(timeZone, formatter); }
  return formatter;
};
export function localParts(now = Date.now(), timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return {date: `${parts.year}-${parts.month}-${parts.day}`, day: parts.weekday.toLowerCase().slice(0, 3), minutes: Number(parts.hour) * 60 + Number(parts.minute)};
}

// The real moment at which today's clock first shows `at` or later. Found by looking at the clock itself,
// minute by minute, so it is right on the two days a year the clocks change and in zones whose change is not
// a whole hour:
//   - a time the clocks skip (02:30 on the spring day) is the moment they jump past it, whenever it is asked
//   - a time that happens twice (01:30 on the autumn day) is the first of the two
// Infinity when today's clock never reaches it. Remembered per zone, date and time (asked every half minute).
const moments = new Map();
export function scheduledMoment(at, now = Date.now(), timeZone = TIME_ZONE) {
  const target = minutesOf(at), today = localParts(now, timeZone), key = `${timeZone}|${today.date}|${at}`;
  if (moments.has(key)) return moments.get(key);
  // The first minute of today's date: walk back by the hour until the date changes, then forward by the minute.
  let start = now - (now % 60000);
  for (let hours = 0; hours < 30 && localParts(start, timeZone).date === today.date; hours++) start -= 3600000;
  for (let minutes = 0; minutes < 130 && localParts(start, timeZone).date !== today.date; minutes++) start += 60000;
  // Clocks move by at most two hours in a day, so the answer is no earlier than two hours before the plain sum.
  let moment = Infinity;
  for (let offset = Math.max(0, target - 120); offset < 1680; offset++) {
    const seen = localParts(start + offset * 60000, timeZone);
    if (seen.date !== today.date) { if (offset > 60) break; continue; }
    if (seen.minutes >= target) { moment = start + offset * 60000; break; }
  }
  if (moments.size > 500) moments.clear();
  moments.set(key, moment);
  return moment;
}

// Pure. What should happen right now: each enabled job whose moment has come today and that has no entry for
// today yet. `missed` = that moment was more than lateMinutes of real time ago (the services were off).
export function dueJobs(schedule, state, now = Date.now(), {timeZone = TIME_ZONE, lateMinutes = LATE_MINUTES} = {}) {
  if (!schedule || schedule.error || schedule.paused || !state || state.unreadable) return [];
  const {date, day} = localParts(now, timeZone);
  return schedule.jobs.filter(job => job.enabled && job.days.includes(day) && state.last?.[job.id]?.date !== date)
    .map(job => ({job, date, moment: scheduledMoment(job.at, now, timeZone)})).filter(due => now >= due.moment)
    .map(due => ({job: due.job, date: due.date, missed: now - due.moment > lateMinutes * 60000}));
}

// "today 07:00", "tomorrow 07:00" or "Fri 07:00": the next time each job will run, for the listing.
export function nextRun(job, state, now = Date.now(), {timeZone = TIME_ZONE, lateMinutes = LATE_MINUTES} = {}) {
  if (!job.enabled) return 'off';
  const {date, day} = localParts(now, timeZone), today = DAYS.indexOf(day);
  for (let ahead = 0; ahead < 8; ahead++) {
    const name = DAYS[(today + ahead) % 7];
    if (!job.days.includes(name)) continue;
    if (ahead === 0 && (state.last?.[job.id]?.date === date || now - scheduledMoment(job.at, now, timeZone) > lateMinutes * 60000)) continue;
    return `${ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : name[0].toUpperCase() + name.slice(1)} ${job.at}`;
  }
  return 'never';
}

// The same job on the same day in the same vault always gets the same task ID, so starting it a second time
// is recognised as the run that already exists instead of becoming a new one. The vault is part of it: one
// installation pointed at a second vault must not find the first vault's run under the same ID.
export function scheduledTaskId(jobId, date, vault = '') {
  const hex = crypto.createHash('sha256').update(`agentic-os-v2 scheduled run\n${path.resolve(String(vault))}\n${jobId}\n${date}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function recordScheduledRun(root, state, {job, date}, outcome, now = Date.now()) {
  const entry = {date, at: new Date(now).toISOString(), ...outcome};
  const history = [...state.history.filter(item => !(item.id === job.id && item.date === date)), {id: job.id, skill: job.skill, ...entry}].slice(-40);
  const next = {version: 1, last: {...state.last, [job.id]: entry}, history};
  atomicJson(inVault(root, SCHEDULE_STATE_FILE), next);
  return next;
}

// One look at the clock. `launch(job, taskId)` starts the workflow and returns its task; it throws when it
// cannot. Returns what it did, for the tests. Never throws: a schedule fault must not reach the bridge.
export function scheduleTick(root, launch, {now = Date.now(), timeZone = TIME_ZONE, lateMinutes = LATE_MINUTES} = {}) {
  const done = [];
  try {
    const schedule = readSchedule(root);
    let state = readScheduleState(root);
    for (const due of dueJobs(schedule, state, now, {timeZone, lateMinutes})) {
      let outcome;
      if (due.missed) outcome = {outcome: 'missed', detail: `The services were not running at ${due.job.at}.`};
      else {
        const taskId = scheduledTaskId(due.job.id, due.date, root);
        // Written down first. If this cannot be saved, nothing is started: the next look would not know.
        state = recordScheduledRun(root, state, due, {outcome: 'starting', taskId}, now);
        try { launch(due.job, taskId); outcome = {outcome: 'started', taskId}; }
        catch (error) { outcome = {outcome: 'failed', taskId, detail: String(error?.message || error).slice(0, 300)}; }
      }
      try { state = recordScheduledRun(root, state, due, outcome, now); } catch { state = {...state, last: {...state.last, [due.job.id]: {date: due.date, ...outcome}}}; }
      done.push({id: due.job.id, skill: due.job.skill, ...outcome});
    }
  } catch { /* an unwritable record or a full disk: nothing further is started on this look */ }
  return done;
}

// What the screens and the command line show.
export function scheduleView(root, {now = Date.now(), timeZone = TIME_ZONE} = {}) {
  const schedule = readSchedule(root), state = readScheduleState(root);
  const error = schedule.error || (state.unreadable ? 'system/v2/schedule-state.json cannot be read, so nothing will run: whether today\'s runs already happened is unknown. Fix or remove that file.' : '');
  return {paused: schedule.paused, error, timeZone, revision: schedule.revision,
    jobs: schedule.jobs.map(job => ({...job, label: SKILLS[job.skill].label, next: schedule.paused ? 'paused' : state.unreadable ? 'not running' : nextRun(job, state, now, {timeZone}), last: state.last[job.id] || null})),
    history: state.history.slice(-10).reverse()};
}
