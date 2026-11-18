// `node aos.mjs schedule ...`: run a bundled workflow by itself at a set time.
// Edits system/v2/schedule.json in the vault; the bridge reads it on its next look at the clock (within
// half a minute), so no restart is needed. Nothing is scheduled until the member adds something.
import {layout, configuredVaultPath} from './services.mjs';
import {readSchedule, editSchedule, scheduleView, schedulableSkills, DAYS, WEEKDAYS} from '../../runner/schedule.mjs';

export const SCHEDULE_HELP = `Scheduled workflows

  schedule                              what is scheduled, when each runs next, and how the last run went
  schedule skills                       the workflows that can be scheduled
  schedule add <workflow> <HH:MM> [--days daily|weekdays|mon,wed,fri]
                                        for example: schedule add plan-today 07:00 --days weekdays
  schedule remove <id>                  take one off the schedule (the id is shown in the list)
  schedule on <id> | off <id>           switch one on or off without removing it
  schedule pause | resume               stop or restart every scheduled run

A scheduled run happens only while the services are running, and uses your Claude or Codex plan
exactly as pressing the button does. If the services were off at the set time, the run is caught up
when they start, the same day, up to three hours late; after that it is recorded as missed.
`;

const daysFrom = value => {
  if (value === true) throw new Error('--days needs a value: daily, weekdays, or a list such as mon,wed,fri.');
  if (value === undefined || value === 'daily') return [...DAYS];
  if (value === 'weekdays') return [...WEEKDAYS];
  const names = {sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat'};
  const days = String(value).toLowerCase().split(',').map(day => day.trim()).filter(Boolean).map(day => names[day] || day);
  if (!days.length || days.some(day => !DAYS.includes(day))) throw new Error(`--days takes daily, weekdays, or a list such as mon,wed,fri.`);
  return days;
};
const dayText = days => days.length === 7 ? 'every day' : days.join(',') === WEEKDAYS.join(',') ? 'weekdays' : days.join(', ');

export async function scheduleCommand({words = [], flags = {}, log = console.log, root, at = layout(root), vault = configuredVaultPath(at), now = Date.now()} = {}) {
  if (!vault) throw new Error('Nothing is installed here yet. Run `node aos.mjs setup --vault "<path>"` first.');
  const [action, ...rest] = words;
  const find = (schedule, id) => { const job = schedule.jobs.find(item => item.id === id); if (!job) throw new Error(`Nothing on the schedule is called "${String(id).slice(0, 60)}". \`node aos.mjs schedule\` shows the ids.`); return job; };
  switch (action) {
    case undefined: case 'list': case 'show': break;
    case 'help': log(SCHEDULE_HELP); return 0;
    case 'skills': for (const skill of schedulableSkills()) log(`  ${skill.id.padEnd(22)} ${skill.label}`); return 0;
    case 'add': {
      if (rest.length !== 2) throw new Error('Use: schedule add <workflow> <HH:MM> [--days daily|weekdays|mon,wed,fri]');
      const stray = Object.keys(flags).find(name => name !== 'days');
      if (stray !== undefined) throw new Error(`--${stray} is not an option of schedule add. Did you mean --days? Nothing was scheduled.`);
      const days = daysFrom(flags.days);
      const saved = editSchedule(vault, schedule => ({...schedule, jobs: [...schedule.jobs, {skill: rest[0], at: rest[1], days}]}));
      const job = saved.jobs.at(-1);
      log(`Scheduled: ${scheduleView(vault, {now}).jobs.at(-1).label} at ${job.at}, ${dayText(job.days)} (id ${job.id}).`);
      log('It runs by itself while the services are running, and uses your Claude or Codex plan the same as pressing the button.');
      return 0;
    }
    case 'remove': { if (rest.length !== 1) throw new Error('Use: schedule remove <id>'); editSchedule(vault, schedule => { find(schedule, rest[0]); return {...schedule, jobs: schedule.jobs.filter(job => job.id !== rest[0])}; }); log(`Removed ${rest[0]} from the schedule.`); return 0; }
    case 'on': case 'off': { if (rest.length !== 1) throw new Error(`Use: schedule ${action} <id>`); editSchedule(vault, schedule => { find(schedule, rest[0]); return {...schedule, jobs: schedule.jobs.map(job => job.id === rest[0] ? {...job, enabled: action === 'on'} : job)}; }); log(`${rest[0]} is ${action}.`); return 0; }
    case 'pause': case 'resume': { editSchedule(vault, schedule => ({...schedule, paused: action === 'pause'})); log(action === 'pause' ? 'Every scheduled run is paused. `node aos.mjs schedule resume` starts them again.' : 'Scheduled runs are on again.'); return 0; }
    default: log(SCHEDULE_HELP); return 1;
  }
  const view = scheduleView(vault, {now});
  if (view.error) { log(view.error); return 1; }
  if (!view.jobs.length) { log('Nothing is scheduled. Example: node aos.mjs schedule add plan-today 07:00 --days weekdays'); log('`node aos.mjs schedule help` explains the rest.'); return 0; }
  if (view.paused) log('Every scheduled run is PAUSED (`node aos.mjs schedule resume`).');
  for (const job of view.jobs) {
    const last = job.last ? `${job.last.outcome}${job.last.detail ? ` (${job.last.detail})` : ''} on ${job.last.date}` : 'has not run yet';
    log(`  ${job.id.padEnd(26)} ${job.label}, ${job.at} ${dayText(job.days)}${job.enabled ? '' : ' [off]'}   next: ${job.next}   last: ${last}`);
  }
  log(`\nTimes follow this computer's clock (${view.timeZone}). Runs happen only while the services are running.`);
  return 0;
}
