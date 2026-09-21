import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { findCli } from './adapters.mjs';
import { codexWindows } from '../shared/usage.mjs';
// One short-lived read-only connection per two minutes, shared by all HTTP clients.
// No thread/start, turn/start, prompts, terminal PTYs, or ledger scans.
export function readAccountLimits() {
    return new Promise((resolve, reject) => {
        const cli = findCli('codex');
        if (!cli) {
            reject(new Error('Codex CLI is not installed.'));
            return;
        }
        const proc = spawn(cli.command, [...cli.prefix, 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const lines = createInterface({ input: proc.stdout });
        let settled = false;
        const finish = (error, value) => { if (settled)
            return; settled = true; clearTimeout(timer); lines.close(); proc.stdin.end(); proc.kill(); if (error)
            reject(error);
        else
            resolve(value); };
        const timer = setTimeout(() => finish(new Error('Codex usage request timed out.')), 20000);
        const send = (message) => proc.stdin.write(JSON.stringify(message) + '\n');
        proc.on('error', () => finish(new Error('Could not start the Codex usage reader.')));
        proc.stdin.on('error', () => finish(new Error('Codex usage connection closed.')));
        proc.on('exit', () => finish(new Error('Codex usage reader exited before responding.')));
        lines.on('line', line => {
            let m;
            try {
                m = JSON.parse(line);
            }
            catch {
                return;
            }
            if (m.id === 0) {
                if (m.error) {
                    finish(new Error('Codex usage connection could not initialize.'));
                    return;
                }
                send({ method: 'initialized', params: {} });
                send({ id: 1, method: 'account/rateLimits/read', params: {} });
            }
            if (m.id === 1) {
                if (m.error)
                    finish(new Error('Account usage is unavailable. Check the Codex CLI sign-in.'));
                else
                    finish(null, m.result);
            }
            // Never approve a server-initiated action as part of a usage read.
            if (m.method && m.id != null)
                send({ id: m.id, error: { code: -32601, message: 'This client only reads account usage.' } });
        });
        send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'jarvis_usage', title: 'Jarvis account usage', version: '0.1.0' } } });
    });
}
let cached = null, nextRead = 0, inflight = null;
export async function getCodexUsage() {
    if (cached && Date.now() < nextRead)
        return cached;
    if (inflight)
        return inflight;
    inflight = (async () => {
        try {
            const windows = codexWindows(await readAccountLimits());
            cached = { status: windows.length ? 'ok' : 'unavailable', checkedAt: new Date().toISOString(), windows, ...(!windows.length ? { message: 'No general Codex quota window was reported for this sign-in.' } : {}) };
        }
        catch (e) {
            cached = { status: cached?.windows.length ? 'stale' : 'unavailable', checkedAt: cached?.checkedAt || null, windows: cached?.windows || [], message: e instanceof Error ? e.message : 'Usage unavailable' };
        }
        finally {
            nextRead = Date.now() + 120000;
            inflight = null;
        }
        return cached;
    })();
    return inflight;
}
