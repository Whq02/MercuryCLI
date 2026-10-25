import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const state = await import('../../src/utils/verification/verificationState.js')
const { createBashShellProvider } = await import('../../src/utils/shell/bashProvider.js')
const root = mkdtempSync(join(tmpdir(), 'piped-verification-'))
try {
  const runner = join(root, 'pytest')
  writeFileSync(runner, '#!/bin/sh\nexit 7\n')
  chmodSync(runner, 0o755)
  const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })
  const command = `${runner} | tail -n 1`
  const built = await provider.buildExecCommand(command, { id: 'pipeline-proof' }) as any
  execFileSync('/bin/bash', ['-c', built.commandString], { cwd: root })
  const pipeline = built.pipelineStatusPath ? readFileSync(built.pipelineStatusPath, 'utf8').trim().split(/\s+/).map(Number) : undefined
  const failures: string[] = []
  if (pipeline?.[0] !== 7 || pipeline?.[1] !== 0) failures.push('Bash lost PIPESTATUS for the failing test runner')
  state.recordShellCommandOutcome(command, 0, root, undefined, pipeline)
  if (state.verificationSummary(root).lastEvidence?.ok !== false) failures.push('pipeline head failure was not recorded')
  for (const text of ['timeout 60s bash scripts/check.sh', 'nice -n 5 nohup bash scripts/check.sh', 'stdbuf -oL -eL bash scripts/check.sh', 'python -W ignore -m unittest']) {
    if (!state.classifyVerificationCommand(text, root)) failures.push(`wrapper not recognized: ${text}`)
  }
  for (const text of ['echo pytest | tail', 'false && pytest | tail', 'pytest || true', 'pytest | tail; true']) {
    if (state.classifyVerificationCommand(text, root, { code: 1, pipelineStatus: [0, 0] })) failures.push(`unattributed check accepted: ${text}`)
  }
  state._resetVerificationStateForTesting()
  state.recordShellCommandOutcome('pytest | tail', 0, root)
  const note = (state as any).takeUnscoredVerification?.()
  if (!note?.includes('pytest | tail') || !/exit status/.test(note)) failures.push('unscored piped check has no stop-gate explanation')
  assert.deepEqual(failures, [])
  for (const file of [built.cwdFilePath, built.pipelineStatusPath]) if (file) rmSync(file, { force: true })
  if (existsSync('/bin/zsh')) {
    const zsh = await createBashShellProvider('/bin/zsh', { skipSnapshot: true })
    const z = await zsh.buildExecCommand(command, { id: 'pipeline-zsh-proof' })
    execFileSync('/bin/zsh', ['-c', z.commandString], { cwd: root })
    assert.deepEqual(readFileSync(z.pipelineStatusPath!, 'utf8').trim().split(/\s+/).map(Number), [7, 0])
    for (const file of [z.cwdFilePath, z.pipelineStatusPath]) if (file) rmSync(file, { force: true })
  }
  const { exec } = await import('../../src/utils/Shell.js')
  const shell = await exec(command, new AbortController().signal, 'bash', { timeout: 10000, cwd: root, preventCwdChanges: true } as never)
  const result = await shell.result
  assert.deepEqual(result.pipelineStatus, [7, 0], 'the spawned shell carries the pipeline array into its settled result')
  shell.cleanup()
  const { observeToolTerminal } = await import('../../src/services/run/effectObserver.js')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.js')
  state._resetVerificationStateForTesting()
  observeToolTerminal({ owner: processMainOwner(), toolName: 'Bash', toolUseId: 'pipeline', input: { command }, ok: true, durationMs: 1, effect: undefined, cwd: root, shellOutcome: result })
  assert.equal(state.verificationSummary(root).lastEvidence?.ok, false)
  console.log('piped verification attribution, wrappers and unscored gate: PASS')
} finally { rmSync(root, { recursive: true, force: true }) }
