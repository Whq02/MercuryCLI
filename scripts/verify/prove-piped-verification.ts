import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const state = await import('../../src/platform/verification/verificationState.js')
const { createBashShellProvider } = await import('../../src/platform/shell/bashProvider.js')
const { systemShellAt, systemShellRecord } = await import('../../src/platform/shell/shellRecord.js')
const root = mkdtempSync(join(tmpdir(), 'piped-verification-'))
try {
  const runner = join(root, 'pytest')
  writeFileSync(runner, '#!/bin/sh\nexit 7\n')
  chmodSync(runner, 0o755)
  const provider = await createBashShellProvider(systemShellAt('/bin/bash'), { skipSnapshot: true })
  const command = `${runner} | tail -n 1`
  const built = await provider.buildExecCommand(command, { id: 'pipeline-proof' }) as any
  execFileSync('/bin/bash', ['-c', built.commandString], { cwd: root })
  const pipeline = built.pipelineStatusPath ? readFileSync(built.pipelineStatusPath, 'utf8').trim().split(/\s+/).map(Number) : undefined
  const failures: string[] = []
  if (pipeline?.[0] !== 7 || pipeline?.[1] !== 0) failures.push('Bash lost PIPESTATUS for the failing test runner; fix buildExecCommand in src/platform/shell/bashProvider.ts so the pipeline status file keeps every pipe stage exit')
  state.recordShellCommandOutcome(command, 0, root, undefined, pipeline)
  if (state.verificationSummary(root).lastEvidence?.ok !== false) failures.push('pipeline head failure was not recorded; fix recordShellCommandOutcome in src/platform/verification/verificationState.ts to score a pipeline by its recorded status array')
  for (const text of ['timeout 60s bash scripts/check.sh', 'nice -n 5 nohup bash scripts/check.sh', 'stdbuf -oL -eL bash scripts/check.sh', 'python -W ignore -m unittest']) {
    if (!state.classifyVerificationCommand(text, root)) failures.push(`wrapper not recognized: ${text}; fix classifyVerificationCommand in src/platform/verification/verificationState.ts to see through this wrapper`)
  }
  for (const text of ['echo pytest | tail', 'false && pytest | tail', 'pytest || true', 'pytest | tail; true']) {
    if (state.classifyVerificationCommand(text, root, { code: 1, pipelineStatus: [0, 0] })) failures.push(`unattributed check accepted: ${text}; fix classifyVerificationCommand in src/platform/verification/verificationState.ts so a check whose exit is not attributable to the runner is not scored`)
  }
  state._resetVerificationStateForTesting()
  state.recordShellCommandOutcome('pytest | tail', 0, root)
  const note = (state as any).takeUnscoredVerification?.()
  if (!note?.includes('pytest | tail') || !/exit status/.test(note)) failures.push('unscored piped check has no stop-gate explanation; fix takeUnscoredVerification and recordShellCommandOutcome in src/platform/verification/verificationState.ts to name the command and say exit status')
  const quietCommands = [
    'sleep 90; echo "=== checkpoints ==="; ls -la /project/tools/baker/CHECKPOINT.md /reference/CHECKPOINT.md 2>&1 | sed "s|/project/||"; echo "=== baker builds? ==="; cd /project/tools/baker && cargo build --release 2>&1 | tail -n 1',
    'cd /project/tools/baker && cargo build --release && cargo test --release 2>&1 | grep -E "^test result|running [0-9]+ test" ; cargo test --release >/dev/null 2>&1; echo "test exit: $?"; cargo clippy --release --all-targets -- -D warnings; echo "clippy exit: $?"; cargo fmt --all -- --check; echo "fmt exit: $?"; test ! -f CHECKPOINT.md && echo "checkpoint removed"',
    'cargo build --workspace 2>&1 | grep -E "^error|^  -->" | head -n 12; echo "---"; cargo build --workspace >/dev/null 2>&1; echo "build exit: $?"; echo "--- who holds core files ---"; true',
    'cargo build --workspace >/dev/null 2>&1; echo "workspace build exit: $?"; echo "--- new traces to register ---"; for f in ~/reference/traces/*.jsonl; do b=$(basename "$f"); if [ ! -f "parity/vectors/$b" ] || ! cmp -s "$f" "parity/vectors/$b"; then echo "NEW/CHANGED: $b"; fi; done; echo "--- docs ---"; wc -l docs/reference.md; grep -c "^```cpp\\|^```c++" docs/reference.md || true',
    'cargo test; echo "test exit: $?"; grep missing results.log || true',
    'cargo test; printf "test exit: %s\\n" "$?"; cat results.log | head',
    'cargo test; echo "test exit: $?"',
    'grep cargo build.log | head -n 5',
    'rg pytest results.log | tail -n 5',
    'cat results.log | grep cargo | head',
    'echo "cargo test | tail"',
    'sleep 1; grep cargo build.log | head',
    'wait; cargo build 2>&1 | tail -n 1',
    'set -o pipefail; cargo test | tail; echo "test exit: $?"',
    'cargo test | tail; cargo test >/dev/null 2>&1; printf "test exit: %s\\n" "$?"',
  ]
  for (const text of quietCommands) {
    state._resetVerificationStateForTesting()
    state.recordShellCommandOutcome(text, 0, root)
    if (state.takeUnscoredVerification() !== undefined) failures.push(`diagnostic rebuked: ${text}; fix takeUnscoredVerification in src/platform/verification/verificationState.ts so this diagnostic command is not reported as an unscored check`)
    if (state.evidenceRecordsFor().length !== 0) failures.push(`diagnostic minted evidence: ${text}; fix classifyVerificationCommand in src/platform/verification/verificationState.ts so this command records no evidence`)
  }
  const maskedCommands = [
    'cd /project/mockups/launcher-rs && cargo test --release 2>&1 | grep -E "^test result|running [0-9]+ tests|error" | head -n 8 && cargo clippy --release -- -D warnings 2>&1 | tail -n 2 && cargo fmt --all -- --check && echo "fmt OK"',
    'pytest | tail',
    'cargo test 2>&1 | grep error | head',
    'pytest || true',
    'pytest | tail; true',
    'cargo test | tail; echo "test exit: $?"',
    'cargo test | tail; cargo test --other >/dev/null 2>&1; echo "test exit: $?"',
    'cargo test "one" | tail; cargo test "two" >/dev/null 2>&1; echo "test exit: $?"',
    'cargo test | tail; cd other; cargo test >/dev/null 2>&1; echo "test exit: $?"',
    "cargo test | tail; cargo test >/dev/null 2>&1; echo 'test exit: $?'",
    'cargo test | tail; cargo test >/dev/null 2>&1; echo "test exit: \\$?"',
    'cargo test | tail; cargo test >/dev/null 2>&1; true; echo "test exit: $?"',
  ]
  for (const text of maskedCommands) {
    state._resetVerificationStateForTesting()
    state.recordShellCommandOutcome(text, 0, root)
    if (state.takeUnscoredVerification() === undefined) failures.push(`masked check went quiet: ${text}; fix recordShellCommandOutcome in src/platform/verification/verificationState.ts so a check whose exit is masked is reported once by takeUnscoredVerification`)
    if (state.evidenceRecordsFor().length !== 0) failures.push(`masked check minted evidence: ${text}; fix classifyVerificationCommand in src/platform/verification/verificationState.ts so a masked check records no evidence`)
    if (state.takeUnscoredVerification() !== undefined) failures.push(`masked check rebuked twice: ${text}; fix takeUnscoredVerification in src/platform/verification/verificationState.ts so it clears the note once taken`)
  }
  state._resetVerificationStateForTesting()
  state.recordShellCommandOutcome('cd /project && pytest | tail', 0, root, undefined, [7, 0])
  if (state.takeUnscoredVerification() !== undefined) failures.push('a recorded pipeline status was called hidden when only cwd binding prevented scoring; fix hasMaskedVerification in src/platform/verification/verificationState.ts to honour a recorded pipeline status')
  assert.deepEqual(failures, [], `${failures.length} check(s) failed: ${failures.join(' | ')}`)
  for (const file of [built.cwdFilePath, built.pipelineStatusPath]) if (file) rmSync(file, { force: true })
  const road = await systemShellRecord()
  if (road.origin !== 'engine') {
    const own = await createBashShellProvider(road, { skipSnapshot: true })
    const r = await own.buildExecCommand(command, { id: 'pipeline-road-proof' })
    execFileSync(road.path, ['-c', r.commandString], { cwd: root })
    assert.deepEqual(readFileSync(r.pipelineStatusPath!, 'utf8').trim().split(/\s+/).map(Number), [7, 0], `the shell the system road runs (${road.path}, ${road.origin}) carries the pipeline array`)
    for (const file of [r.cwdFilePath, r.pipelineStatusPath]) if (file) rmSync(file, { force: true })
  }
  const { exec } = await import('../../src/platform/shell/shellExec.js')
  const shell = await exec(command, new AbortController().signal, 'bash', { timeout: 10000, cwd: root, preventCwdChanges: true } as never)
  const result = await shell.result
  assert.deepEqual(result.pipelineStatus, [7, 0], 'the spawned shell carries the pipeline array into its settled result; fix exec in src/platform/shell/shellExec.ts to return the pipeline status of the settled command')
  shell.cleanup()
  for (const text of [`${runner}; echo "test exit: $?"`, `${runner} | tail; ${runner} >/dev/null 2>&1; echo "test exit: $?"`]) {
    const running = await exec(text, new AbortController().signal, 'bash', { timeout: 10000, cwd: root })
    const printed = await running.result
    running.cleanup()
    assert.equal(printed.code, 0, `exec in src/platform/shell/shellExec.ts returned code ${printed.code} for: ${text}`)
    assert.match(printed.stdout, /test exit: 7/, `exec in src/platform/shell/shellExec.ts printed ${JSON.stringify(printed.stdout)} for: ${text}`)
    state._resetVerificationStateForTesting()
    state.recordShellCommandOutcome(text, printed.code, root, undefined, printed.pipelineStatus)
    assert.equal(state.takeUnscoredVerification(), undefined, `a printed failing status must not be called unscored; fix takeUnscoredVerification in src/platform/verification/verificationState.ts for: ${text}`)
    assert.equal(state.evidenceRecordsFor().length, 0, 'a printed failing status is not passing evidence; fix classifyVerificationCommand in src/platform/verification/verificationState.ts')
  }
  const { observeToolTerminal } = await import('../../src/engine/run-owner/effectObserver.js')
  const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.js')
  state._resetVerificationStateForTesting()
  observeToolTerminal({ owner: processMainOwner(), toolName: 'Bash', toolUseId: 'pipeline', input: { command }, ok: true, durationMs: 1, effect: undefined, cwd: root, shellOutcome: result })
  assert.equal(state.verificationSummary(root).lastEvidence?.ok, false, 'the Bash tool terminal did not record a failing check as evidence; fix observeToolTerminal in src/engine/run-owner/effectObserver.ts and observeCompletedToolCall in src/platform/verification/verificationState.ts so the shellOutcome reaches recordShellCommandOutcome')
  console.log('piped verification attribution, wrappers and unscored gate: PASS')
} finally { rmSync(root, { recursive: true, force: true }) }
