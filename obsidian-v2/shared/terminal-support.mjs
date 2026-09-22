// Which versions of the Terminal community plugin (by polyipseity) the Obsidian
// integration works with. The plugin reaches into Terminal's internals (view
// state, profile fields, emulator and process access), so a version is either
// verified against its sources or treated with care. Shared by the plugin and
// the doctor; keep it browser-compatible (no Node imports).
export const VERIFIED_TERMINAL_VERSIONS = Object.freeze(['3.27.1', '3.27.2']);
export const JARVIS_URL = 'http://127.0.0.1:3217';

const IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function parse(version) {
  const match = SEMVER.exec(version);
  return match ? {core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || ''} : null;
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const verified = VERIFIED_TERMINAL_VERSIONS.map(parse);
const lowest = verified[0].core, highest = verified[verified.length - 1].core;
const tested = VERIFIED_TERMINAL_VERSIONS.join(', ');

/** status: 'missing' | 'verified' | 'untested' | 'unsupported'.
 * Only 'verified' and 'untested' may open conversations; 'untested' (a stable
 * 3.x newer than every verified version) always comes with its message. */
export function terminalSupport(version) {
  if (version === undefined || version === null || (typeof version === 'string' && !version.trim())) return {status: 'missing', version: null,
    message: `Conversations inside Obsidian need the Terminal community plugin (by polyipseity). Install it from Settings → Community plugins, or use the same button in Jarvis at ${JARVIS_URL}.`};
  const text = String(version), parsed = typeof version === 'string' ? parse(version) : null;
  const notVerified = {status: 'unsupported', version: text,
    message: `Terminal ${text} has not been verified with Agentic OS. Use Jarvis at ${JARVIS_URL} until Agentic OS is updated (node aos.mjs update).`};
  if (!parsed) return notVerified;
  if (verified.some(entry => !compare(entry.core, parsed.core) && entry.prerelease === parsed.prerelease)) return {status: 'verified', version: text, message: ''};
  if (parsed.prerelease) return {status: 'unsupported', version: text,
    message: `Pre-release Terminal versions (${text}) are not supported by Agentic OS. Install the regular release from Settings → Community plugins, or use Jarvis at ${JARVIS_URL}.`};
  if (parsed.core[0] === highest[0] && compare(parsed.core, highest) > 0) return {status: 'untested', version: text,
    message: `Terminal ${text} is newer than the versions tested with Agentic OS (${tested}). Conversations should still work; if one misbehaves, use the same button in Jarvis at ${JARVIS_URL} and run the doctor.`};
  if (compare(parsed.core, lowest) < 0) return {status: 'unsupported', version: text,
    message: `Terminal ${text} is too old for Agentic OS. Update it in Settings → Community plugins, or use Jarvis at ${JARVIS_URL}.`};
  return notVerified;
}

/** The message when an untested Terminal opened a conversation's tab but its
 * process could not be followed. It may be running, so nothing is relaunched. */
export const untrackedLaunchMessage = version => `Terminal ${version} opened this conversation, but Agentic OS cannot follow it in this Terminal version. It may still be running: check that tab and close it before trying again. For tracked conversations and voice follow-ups use Jarvis at ${JARVIS_URL}, and run the doctor.`;
