---
name: codex-build
description: Delegate implementation of a concrete plan to a Codex builder, then review the diff and verify the result. Use for explicit /codex-build or requests to have Codex implement a supplied spec. Keep design decisions with the supervising agent; simple local edits do not need delegation.
---

# Codex Build

The supervising agent owns the spec, review, and user communication. The delegated
builder implements the authorized scope. A fresh session is not necessarily a
different model. Adapted from Peter Steinberger’s codex-first pattern.

## Prepare

- Read the supplied plan (default `PLAN.md`). Include the goal, relevant paths,
  constraints, non-goals, deliverables, and acceptance checks in a self-contained
  prompt. If requirements are incomplete, resolve what the repository can answer
  and ask only for decisions that materially affect the build.
- Infer the proof command from the spec, repository instructions, package scripts,
  or CI. Ask only when the acceptance check remains ambiguous.
- Inspect the working tree. Preserve existing work; use an isolated checkout when
  appropriate and authorized, including the relevant uncommitted input changes.
  Never stash, discard, or overwrite unrelated work to obtain a clean tree.
- Check `codex --version`, `codex exec --help`, and `codex exec resume --help`.
  Keep the configured model unless the user chose another. Record actual model
  metadata if exposed; report unknown otherwise. Check capabilities needed by the
  spec instead of assuming image generation, MCP, or credentials are available.
- Use the permissions already authorized for the task. This skill does not grant
  unrestricted filesystem access or authorize bypassing approval or sandbox checks.

## Execute

Write the prompt as UTF-8 to a unique file in the task workspace. Run from the
target checkout. Keep prompt, final report, JSONL events, and stderr in that run’s
directory. Use workspace-write for authorized repository edits when supported;
respect any stricter host policy.

PowerShell example (set the four paths first):

```powershell
Get-Content -LiteralPath $buildPromptPath -Raw |
    codex exec -s workspace-write --json -o $buildReportPath - 2> $buildErrorPath |
    Set-Content -LiteralPath $buildEventsPath -Encoding utf8
$buildExitCode = $LASTEXITCODE
```

Bash example:

```bash
codex exec -s workspace-write --json -o "$build_report_path" - < "$build_prompt_path" > "$build_events_path" 2> "$build_error_path"
build_exit_code=$?
```

Use the current host’s nonblocking process/session support and poll to completion;
do not pass Bash-tool timeout or background fields to a different tool interface.
Capture the explicit session ID from the `thread.started` event. Require a zero
process exit code and a substantive final report before treating execution as
complete. A started event is not a success signal. Inspect stderr on failure.

## Verify and repair

1. The supervising agent reads the full diff against the recorded starting state,
   checks scope and correctness, and runs the relevant proof checks.
2. If corrections are needed, write a focused fix prompt and resume the explicit
   session ID from the same checkout. Preserve the original permission policy;
   for CLI resume use its supported config mechanism, such as
   `-c sandbox_mode='"workspace-write"'`, after checking current help.
3. Default to at most two delegated fix rounds (`MAX_FIX_ROUNDS=2`). After the cap,
   the supervising agent finishes remaining authorized corrections directly.
4. Append results and evidence to `PLAN-REVIEW-LOG.md` or the user’s selected log.

## Finish

Present the implementation, verification result, deviations, and remaining issues.
The supervising agent owns commits and remote actions; the builder does not commit
or push. Apply the user’s existing authorization: if commit/push is already requested,
perform it after verification; otherwise show the diff and obtain that authorization
before taking those additional actions. Preserve any explicit user-requested gates.
