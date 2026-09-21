// ---------------------------------------------------------------------------
// normalizeForSpeech(text) — last-mile rewrite before ANY TTS engine.
// Kokoro reads "$4,200" as "dollar 4 200" and "$200M" as "dollar 2 M";
// spelling money out in words fixes every source at once (router replies,
// mined headlines, run summaries). Pure module — no env, no fs.
// ---------------------------------------------------------------------------

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety",
];

function numWords(n: number): string {
  if (n < 0) return `minus ${numWords(-n)}`;
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1_000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numWords(n % 100)}` : ""}`;
  if (n < 1_000_000) return `${numWords(Math.floor(n / 1_000))} thousand${n % 1_000 ? ` ${numWords(n % 1_000)}` : ""}`;
  if (n < 1_000_000_000) return `${numWords(Math.floor(n / 1_000_000))} million${n % 1_000_000 ? ` ${numWords(n % 1_000_000)}` : ""}`;
  return `${numWords(Math.floor(n / 1_000_000_000))} billion${n % 1_000_000_000 ? ` ${numWords(n % 1_000_000_000)}` : ""}`;
}

// "1.5" → "one point five" (decimals read digit-by-digit after the point)
function decimalWords(s: string): string {
  const [int, frac] = s.split(".");
  // Unsafe integers must never be coerced through a floating-point number.
  const value = Number(int);
  const head = Number.isSafeInteger(value) ? numWords(value) : [...int!].map(d => ONES[Number(d)]).join(" ");
  if (!frac) return head;
  return `${head} point ${[...frac].map((d) => ONES[parseInt(d, 10)]).join(" ")}`;
}

const SUFFIX: Record<string, string> = {
  k: "thousand",
  m: "million",
  b: "billion",
  t: "trillion",
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Presentation only: these functions never replace exact quantities with an
// estimate. Ambiguous dates, durations and identifiers stay literal.
function clockTime(h: string, m: string, ap = ''): string {
  let hour = Number(h);
  if (hour > 23 || (ap && (hour < 1 || hour > 12))) return `${h}:${m}${ap ? ' ' + ap : ''}`;
  let suffix = ap.replace(/\./g, '').toUpperCase();
  if (!suffix) { suffix = hour >= 12 ? 'PM' : 'AM'; hour = hour % 12 || 12; }
  return `${hour}${m === '00' ? '' : ' ' + (m.startsWith('0') ? 'oh ' + m[1] : m)} ${suffix}`;
}

function durationWords(parts: string[]): string {
  const units = parts.length === 3 ? ['hour', 'minute', 'second'] : ['minute', 'second'];
  return parts.map((part, i) => Number(part) ? `${decimalWords(part)} ${units[i]}${Number(part) === 1 ? '' : 's'}` : '').filter(Boolean).join(' and ') || 'zero seconds';
}

function speechMarkup(text: string): string {
  let t = text.replace(/<!--[^]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<sup\b([^>]*)>\s*(\[?\d+(?:\s*[,–-]\s*\d+)*\]?)\s*<\/sup>/gi, (_raw, attrs: string, number: string, offset: number, source: string) => {
      if (/\b(?:citation|reference|footnote)\b/i.test(attrs) || /^\[.*\]$/.test(number)) return '';
      // An unmarked superscript might be an exponent, not a source number.
      return /(?:^|[^\w])(?:[A-Za-z]|\d+(?:\.\d+)?)$/.test(source.slice(Math.max(0, offset - 80), offset)) ? ' to the power of ' + number : ' superscript ' + number;
    })
    .replace(/<\/?(?:blockquote|br|div|h[1-6]|hr|li|ol|p|ul)\b[^>]*>/gi, ' ')
    .replace(/<\/?(?:a|abbr|b|code|del|em|i|mark|small|span|strong|sub|sup|u)\b[^>]*>/gi, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi, entity => {
      const named: Record<string,string> = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
      const code = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
    })
    .replace(/!?\[\[([^\]\n]+)\]\]/g, (_raw, target: string) => {
      const split = target.lastIndexOf('|');
      return split >= 0 ? target.slice(split + 1) : target.replace(/^[^#]*\//, '').replace(/\.(?:md|png|jpe?g|svg|webp|pdf)(?=#|$)/i, '').replace(/#\^?/g, ', ');
    })
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/【\d+†[^】]*】/g, '')
    // Remove prose citation suffixes, not arrays, indices or numbered choices.
    .replace(/[ \t]+\[\d+\](?:[ \t]*\[\d+\])*(?=[.,;!?]|$)/gm, (raw, offset: number, source: string) => {
      const prefix = source.slice(Math.max(0, offset - 80), offset).split(/[.!?\n]/).pop() || '';
      return /\b(?:array|vector|index|item|entry|element|option|choice|step|ticket|question|label)\s*[:#]?\s*$/i.test(prefix) || !/[\p{L}]/u.test(prefix) ? raw : '';
    })
    .replace(/([0-9#*])\uFE0F?\u20E3/g, '$1')
    .replace(/[⚠]\uFE0F?/gu, ' Warning. ')
    .replace(/[❌❎]\uFE0F?/gu, ' No. ')
    .replace(/[✅✔☑]\uFE0F?/gu, ' Check. ')
    .replace(/[❗‼]\uFE0F?/gu, ' Important. ')
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu, symbol => /[←-⇿⟰-⟿➔➜➡±×÷−≠≤≥]/u.test(symbol) ? symbol : ' ');
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}

export function normalizeForSpeech(text: string): string {
  let t = speechMarkup(text);

  // A colon is not necessarily a clock: distinguish explicitly identified
  // media durations, ratios and clock times. Leave unlabeled 01:30 literal.
  t = t.replace(/\b(duration|elapsed|runtime|timestamp|playback|clip length)\s*:?\s*(\d+):([0-5]\d)(?::([0-5]\d))?\b/gi,
    (_raw, label: string, first: string, second: string, third?: string) => `${label} ${durationWords(third === undefined ? [first, second] : [first, second, third])}`);
  t = t.replace(/\b(\d+):([0-5]\d)(?::([0-5]\d))?\s*\((mm:ss|hh:mm:ss)\)/gi,
    (raw, first: string, second: string, third: string | undefined, units: string) => (third === undefined) === (units.toLowerCase() === 'mm:ss') ? durationWords(third === undefined ? [first, second] : [first, second, third]) : raw);
  t = t.replace(/\b(\d{1,2}):([0-5]\d)\s*(a\.?m\.?|p\.?m\.?)\b/gi, (_raw, h: string, m: string, ap: string) => clockTime(h, m, ap));
  t = t.replace(/\b(at|by|until|from|after|before|around)\s+(\d{1,2}):([0-5]\d)\b(?!:)/gi,
    (raw, cue: string, h: string, m: string) => Number(h) > 23 ? raw : Number(h) === 0 || Number(h) > 12 ? `${cue} ${clockTime(h, m)}` : `${cue} ${Number(h)}${m === '00' ? '' : ' ' + (m.startsWith('0') ? 'oh ' + m[1] : m)}`);
  t = t.replace(/\b(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\s+(ratio|aspect ratio)\b/gi, '$1 to $2 $3')
    .replace(/\b(ratio|aspect ratio)\s+(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\b/gi, '$1 $2 to $3');
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b(?![\w/-])/g, (raw, year: string, month: string, day: string, offset: number, source: string) => {
    if (offset && /[\w/\\-]/.test(source[offset - 1]!)) return raw;
    const date = new Date(`${year}-${month}-${day}T12:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day) ? `${MONTHS[Number(month)-1]} ${Number(day)}, ${year}` : raw;
  });

  t = t.replace(/-\s*\$\s*(?=[\d.])|\$\s*-\s*(?=[\d.])/g, 'minus $').replace(/\$\s*\.(?=\d)/g, '$0.');
  // $200M / $1.5B / $10k → "two hundred million dollars"
  t = t.replace(/\$\s?(\d+(?:\.\d+)?)\s?(k|K|[mM]illion|[bB]illion|[tT]rillion|M|B|T)\b/g, (_, num: string, suf: string) => {
    const scale = SUFFIX[suf[0]!.toLowerCase()];
    return `${decimalWords(num)} ${scale} dollars`;
  });

  // Consume the whole value, including cents. Never match only the first
  // three digits of an ungrouped price, and never round away sub-cent prices.
  t = t.replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d,])/g, (_, num: string, fraction?: string) => {
    const whole = num.replace(/,/g, '');
    if (fraction && fraction.length > 2) return `${decimalWords(whole + '.' + fraction)} dollars`;
    const cents = Number((fraction || '').padEnd(2, '0'));
    const dollars = `${decimalWords(whole)} ${Number(whole) === 1 ? 'dollar' : 'dollars'}`;
    if (!cents) return dollars;
    const change = `${numWords(cents)} ${cents === 1 ? 'cent' : 'cents'}`;
    return Number(whole) === 0 ? change : `${dollars} and ${change}`;
  });

  // bare 200M / 1.5B (counts, not money) → "two hundred million"
  t = t.replace(/\b(\d+(?:\.\d+)?)([MBT])\b/g, (_, num: string, suf: string) => {
    return `${decimalWords(num)} ${SUFFIX[suf.toLowerCase()]}`;
  });

  // Keep ordinary counts and identifiers exact. Grouped counts can be read
  // without the commas; no numeric coercion means even long IDs survive.
  t = t.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, number => number.replace(/,/g, ''));
  t = t.replace(/\bgpt[- ]?(\d+(?:\.\d+)*)(?:[- ](astra|luna|sol|terra|fable))?\b/gi,
    (_raw, version: string, model?: string) => `G P T ${version.split('.').map(part => decimalWords(part)).join(' point ')}${model ? ' ' + model[0]!.toUpperCase() + model.slice(1).toLowerCase() : ''}`);
  t = t.replace(/\b(?:AI|API|CLI|CPU|GPU|GPT|HTML|HTTP|HTTPS|JSON|MCP|URL|USB|PDF|TTS|STT)\b/g, acronym => acronym.split('').join(' '));
  t = t.replace(/\b(\d+(?:\.\d+)?)\s*(ms|GB|MB|KB)\b/g, (_raw, value: string, unit: string) => `${value} ${({ms:'milliseconds',GB:'gigabytes',MB:'megabytes',KB:'kilobytes'} as Record<string,string>)[unit]}`)
    .replace(/\b(\d+(?:\.\d+)?)\s*°\s*([CF])\b/g, '$1 degrees $2')
    .replace(/degrees C\b/g, 'degrees Celsius').replace(/degrees F\b/g, 'degrees Fahrenheit')
    .replace(/\s*(?:!=|≠)\s*/g, ' does not equal ')
    .replace(/\s*(?:<=|≤)\s*/g, ' is at most ')
    .replace(/\s*(?:>=|≥)\s*/g, ' is at least ')
    .replace(/\s*±\s*/g, ' plus or minus ')
    .replace(/([A-Za-z0-9.)])\s*<(?![<=-])\s*([A-Za-z0-9(-])/g, '$1 is less than $2')
    .replace(/([A-Za-z0-9.)])\s*>(?![=>])\s*([A-Za-z0-9(-])/g, '$1 is greater than $2')
    .replace(/(?<=\d)\s*[×*]\s*(?=\d)/g, ' times ')
    .replace(/(?<=\d)\s*÷\s*(?=\d)/g, ' divided by ')
    .replace(/\b(\d+(?:\.\d+)?)\s*[–—]\s*(\d+(?:\.\d+)?)/g, '$1 to $2')
    .replace(/\b(\d+(?:\.\d+)?)x(?=\s+(?:performance|faster|slower|speed|speedup|throughput|larger|smaller|increase|improvement|multiplier)\b)/gi, '$1 times')
    .replace(/\b(\d+(?:\.\d+)?)%/g, '$1 percent');
  return t.replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// scrubRunSummary(s) — runner summaries are line 1 of a claude -p reply and
// sometimes leak build jargon the user should never HEAR ("(headless)",
// "SAVED inbox/...", markdown). The runner prompt's spoken-summary contract
// is the real fix; this is the safety net for replies that ignore it.
// ---------------------------------------------------------------------------
// failure summaries are runner internals ("[runner: hard timeout 10m —
// killed]", "spawn error: ENOENT") — translate the known shapes to something
// a person would say before they reach the speakers
export function humanizeFailure(s: string): string {
  if (/hard timeout/i.test(s)) return "it ran past the time limit, so I stopped it.";
  if (/spawn error/i.test(s)) return "I couldn't start the session for it.";
  if (/bad intent json|unknown or invalid intent/i.test(s)) return "the request didn't parse on my end.";
  // unknown shape: scrub bracketed runner internals, keep whatever's human
  return scrubRunSummary(s.replace(/\[runner:[^\]]*\]/gi, "").trim());
}

export function scrubRunSummary(s: string): string {
  let t = speechMarkup(s);
  // trailing "SAVED <path>" protocol line
  t = t.replace(/\bSAVED\s+\S+\s*$/i, "");
  // Remove only standalone transport labels. A parenthetical mentioning a
  // deliverable or exit code can carry a failure, caveat, or useful context.
  t = t.replace(/\s*\(\s*(?:headless|autonomous(?: run)?)\s*\)/gi, "");
  // bare jargon words that survive outside parens
  t = t.replace(/\b(headless(ly)?|autonomous(ly)?)\b/gi, "");
  // markdown chrome reads as noise
  t = t.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_raw, bold: string, underline: string) => bold || underline)
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?;:]|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // file paths spoken aloud are gibberish ("2026 dash 06 dash 12 dash…")
  t = t.replace(/\b[\w.-]+(?:[\\/][\w.-]+)+\.(?:md|json|html|csv)\b/g, "the report");
  return t.replace(/\s{2,}/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
}
