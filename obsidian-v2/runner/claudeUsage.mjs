import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { claudeWindows } from '../shared/usage.mjs';
import { renewClaudeSignIn } from './claude-signin.mjs';
// Same internal account endpoint used by the installed Claude Code /usage command.
// Credentials stay on this loopback server. Never refresh/write Claude's credentials,
// follow redirects, or send tokens to a caller-supplied endpoint. A stale sign-in is
// renewed by the Claude CLI itself (claude-signin.mjs); this reader only re-reads the file.
const endpoint = 'https://api.anthropic.com/api/oauth/usage';
let cached = null, cachedRejected = false, identity = '', nextRead = 0;
let inflight = null;
// Absolute, so this reader and the renewing CLI (which runs elsewhere) open the same credentials file.
const configDir = () => process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;
async function readAuth() {
    try {
        const auth = JSON.parse(await readFile(path.join(configDir() || path.join(homedir(), '.claude'), '.credentials.json'), 'utf8')).claudeAiOauth;
        if (typeof auth?.accessToken !== 'string' || !auth.accessToken)
            return null;
        const past = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Date.now();
        const expired = past(auth.expiresAt);
        const refreshable = typeof auth.refreshToken === 'string' && !!auth.refreshToken.trim() && !past(auth.refreshTokenExpiresAt);
        return { token: auth.accessToken, expired, refreshable, key: createHash('sha256').update(JSON.stringify([auth.accessToken, expired, refreshable])).digest('hex') };
    }
    catch {
        return null;
    }
}
// One caller's patience. The shared renewal and the shared usage read are never cut short by it.
function bounded(promise, ms, signal) {
    if (!(ms > 0) || signal?.aborted)
        return Promise.resolve(undefined);
    return new Promise(resolve => {
        const done = value => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); resolve(value); };
        const aborted = () => done(undefined);
        const timer = setTimeout(aborted, ms);
        signal?.addEventListener('abort', aborted, { once: true });
        Promise.resolve(promise).then(done, () => done(undefined));
    });
}
function sharedRead(auth, renewalMessage) {
    if (inflight?.identity === auth.key)
        return inflight.promise;
    const previous = cached, key = auth.key;
    const promise = (async () => {
        let result, rejected = false;
        try {
            const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${auth.token}`, 'anthropic-beta': 'oauth-2025-04-20' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
            if (response.status === 401 || response.status === 403) {
                rejected = response.status === 401;
                result = { status: 'unavailable', checkedAt: null, windows: [], message: rejected ? renewalMessage : 'Claude denied access to account usage. Check the signed-in account and plan in Claude Code.' };
            }
            else {
                if (!response.ok)
                    throw new Error(response.status === 429 ? 'Claude usage is temporarily rate limited. Retrying after the cache interval.' : 'Claude account usage could not be refreshed.');
                const windows = claudeWindows(await response.json());
                result = { status: windows.length ? 'ok' : 'unavailable', checkedAt: new Date().toISOString(), windows, ...(!windows.length ? { message: 'Claude did not report subscription quota windows for this account.' } : {}) };
            }
        }
        catch {
            result = { status: previous?.windows.length ? 'stale' : 'unavailable', checkedAt: previous?.checkedAt || null, windows: previous?.windows || [], message: 'Claude account usage could not be refreshed. Retrying in two minutes.' };
        }
        if (identity === key) {
            cached = result;
            cachedRejected = rejected;
            nextRead = Date.now() + 120000;
        }
        if (inflight?.promise === promise)
            inflight = null;
        return { result, rejected };
    })();
    inflight = { identity: key, promise };
    return promise;
}
// wait:true (the meter) may wait for a renewal and then shows the reading in the same call; wait:false (voice) starts
// or joins the renewal and answers at once. One overall budget per call: every step gets what is left of it.
export async function getClaudeUsage({ wait = true, signal, renew = renewClaudeSignIn, budgetMs = 22000, renewWaitMs = 10000, read = readAuth } = {}) {
    const started = performance.now(), left = () => budgetMs - (performance.now() - started);
    // The caller ran out of patience or went away: answered from what is known, nothing further is started.
    const timedOut = () => ({ status: cached?.windows.length ? 'stale' : 'unavailable', checkedAt: cached?.checkedAt || null, windows: cached?.windows || [], message: 'Claude account usage is taking longer than usual. Try again in a moment.' });
    let renewed = false;
    for (;;) {
        // Reading the credentials is a step like any other: a stalled disk cannot outlast the budget or a cancellation.
        const auth = await bounded(read(), left(), signal);
        if (auth === undefined)
            return timedOut();
        if (!auth) {
            identity = '';
            cached = null;
            cachedRejected = false;
            nextRead = 0;
            return { status: 'unavailable', checkedAt: null, windows: [], message: 'Claude CLI account sign-in is unavailable. Sign in to Claude Code to read plan usage.' };
        }
        if (auth.key !== identity) {
            identity = auth.key;
            cached = null;
            cachedRejected = false;
            nextRead = 0;
        }
        const renewalMessage = auth.refreshable
            ? 'Claude usage is waiting for Claude Code to refresh its sign-in. Open Claude Code; sign in only if it asks.'
            : 'Claude Code sign-in has expired or was rejected. Open Claude Code and sign in again.';
        // At most one renewal per call, and only where the CLI can renew: never for a sign-in that is really gone.
        // True means "look at the credentials once more"; the renewed pass is judged by that re-read alone.
        const renewal = async () => {
            if (renewed || !auth.refreshable || signal?.aborted)
                return false;
            // A waiting caller with under a second left could not use the result, so it starts nothing.
            if (wait && left() < 1000)
                return false;
            renewed = true;
            const launchKey = auth.key;
            const flight = renew({ identity: launchKey, configDir: configDir(), verify: async () => { const now = await bounded(read(), 5000); return !!now && !now.expired && now.key !== launchKey; } });
            if (!flight || !wait)
                return false;
            await bounded(flight, Math.min(renewWaitMs, left()), signal);
            return left() >= 1000 && !signal?.aborted;
        };
        // Reading the meter never initiates an OAuth refresh itself or mutates the CLI's credential store.
        if (auth.expired) {
            if (await renewal())
                continue;
            return { status: 'unavailable', checkedAt: null, windows: [], message: renewalMessage };
        }
        const known = cached && Date.now() < nextRead;
        if (!known && (signal?.aborted || left() <= 0))
            return timedOut();
        const outcome = known
            ? { result: cached, rejected: cachedRejected }
            : await bounded(sharedRead(auth, renewalMessage), left(), signal);
        if (!outcome)
            return timedOut();
        // A rejected pass (401) gets the same single renewal; 403, rate limits and network failures never do.
        if (outcome.rejected && await renewal())
            continue;
        return outcome.result;
    }
}
