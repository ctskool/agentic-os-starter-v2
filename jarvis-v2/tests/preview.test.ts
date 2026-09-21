import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("preview isolation, input validation, provider capture, and completion", async () => {
  const original = process.cwd();
  const scratch = path.resolve(original, "../../work");
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, "preview-test-"));
  fs.mkdirSync(path.join(fixture, "test-vault/system"), { recursive: true });
  process.chdir(fixture);
  // A production-style environment override must not affect the preview.
  const oldVault = process.env.VAULT_ROOT;
  process.env.VAULT_ROOT = path.join(scratch, "a-production-vault");
  try {
    const preview = await import("../lib/preview");
    assert.equal(preview.TEST_ROOT, path.join(fixture, "test-vault"));
    assert.throws(() => preview.previewState(), /marker missing/);
    fs.writeFileSync(path.join(fixture, "test-vault/.jarvis-v2-test-vault"), "jarvis-v2-preview-only");
    assert.equal(preview.previewState().preview.provider, "codex");
    assert.throws(() => preview.selectProvider("unsupported"));
    assert.throws(() => preview.simulateJob("voice-ask"));
    assert.throws(() => preview.setDirective(-1, true));
    assert.throws(() => preview.setDirective(0, "true"));
    preview.setDirective(0, true);
    assert.equal(preview.previewState().daily?.top3[0].done, true);
    const job = preview.simulateJob("plan-today");
    preview.selectProvider("claude");
    assert.equal(preview.previewState().preview.provider, "claude");
    assert.equal(job.provider, "codex");
    assert.throws(() => preview.simulateJob("metrics-pull"), /already running/);
    const dbPath = path.join(fixture, "test-vault/system/preview.json");
    const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    db.runs[0].ts_started = new Date(Date.now() - 9000).toISOString();
    fs.writeFileSync(dbPath, JSON.stringify(db));
    const done = preview.previewState().runs.find(run => run.id === job.id)!;
    assert.equal(done.status, "ok");
    assert.match(preview.previewReport(done.deliverable_path!), /captured as \*\*codex\*\*/);
    assert.match(preview.previewReport(done.deliverable_path!), /no model was called/);
    assert.throws(() => preview.previewReport("../../.claude/.env"), /not found/);
    assert.equal(preview.sameOrigin(new Request("http://127.0.0.1:3217/api/queue", { headers: { origin: "https://other.example" }})), false);
    assert.equal(preview.sameOrigin(new Request("http://127.0.0.1:3217/api/queue")), false);
    assert.equal(preview.sameOrigin(new Request("http://127.0.0.1:3217/api/queue", { headers: { 'sec-fetch-site': 'same-origin' } })), true);
    assert.equal(preview.sameOrigin(new Request("http://127.0.0.1:3217/api/queue", { headers: { origin: "http://127.0.0.1:3217" }})), true);
    assert.equal(preview.sameOrigin(new Request("http://localhost:3217/api/settings", { headers: { host: "127.0.0.1:3217", origin: "http://127.0.0.1:3217" }})), true);
    assert.equal(preview.sameOrigin(new Request("http://localhost:3217/api/settings", { headers: { host: "evil.example:3217", origin: "http://evil.example:3217" }})), false);
    assert.equal(preview.previewState().runner?.alive, false);
  } finally {
    process.chdir(original);
    if (oldVault === undefined) delete process.env.VAULT_ROOT; else process.env.VAULT_ROOT = oldVault;
  }
});
