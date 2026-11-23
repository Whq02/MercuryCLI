#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'progress-projection-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

const {
  publishEphemeralProgress,
  clearEphemeralProgress,
  getEphemeralProgressFrame,
  subscribeEphemeralProgress,
  _resetEphemeralProgressForTesting,
} = await import('../../src/screen/app-state/ephemeralProgressStore.js')
const { isEphemeralToolProgress } = await import('../../src/sessions/transcripts/paths.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const tick = (toolUseID: string, n: number): never =>
  ({
    type: 'progress',
    parentToolUseID: toolUseID,
    toolUseID: `progress_${toolUseID}_${n}`,
    data: { type: 'bash_progress', elapsedTimeSeconds: n, totalLines: n * 3 },
  }) as never

section('§A the keyed store: replace semantics, per-key wakeups, reset law')
{
  _resetEphemeralProgressForTesting()
  let wakesA = 0
  let wakesB = 0
  const unsubA = subscribeEphemeralProgress('toolA', () => wakesA++)
  const unsubB = subscribeEphemeralProgress('toolB', () => wakesB++)

  for (let i = 1; i <= 60; i++) publishEphemeralProgress(tick('toolA', i))
  check('60 ticks hold ONE frame (replace semantics, no growth)',
    (getEphemeralProgressFrame('toolA') as { data: { elapsedTimeSeconds: number } }).data
      .elapsedTimeSeconds === 60,
    'publishEphemeralProgress in src/screen/app-state/ephemeralProgressStore.ts must replace the frame stored under the tool key, so the latest tick is the one getEphemeralProgressFrame returns')
  check("only toolA's subscriber woke — 60 times", wakesA === 60, `${wakesA} wakes; publishEphemeralProgress in src/screen/app-state/ephemeralProgressStore.ts must notify that key's subscribers once per publish`)
  check("toolB's subscriber NEVER woke (per-key isolation — the one-row law)", wakesB === 0, `${wakesB} wakes; publishEphemeralProgress and subscribeEphemeralProgress in src/screen/app-state/ephemeralProgressStore.ts must wake only the subscribers of the published key`)

  publishEphemeralProgress(tick('toolB', 1))
  check('a toolB tick wakes toolB once and toolA not again', wakesB === 1 && wakesA === 60,
    `toolB woke ${wakesB} time(s), toolA ${wakesA}; publishEphemeralProgress in src/screen/app-state/ephemeralProgressStore.ts must wake only the key it published`)

  clearEphemeralProgress()
  check('clear drops every frame and wakes every subscriber',
    getEphemeralProgressFrame('toolA') === undefined &&
      getEphemeralProgressFrame('toolB') === undefined &&
      wakesA === 61 &&
      wakesB === 2,
    `toolA woke ${wakesA} time(s), toolB ${wakesB}; clearEphemeralProgress in src/screen/app-state/ephemeralProgressStore.ts must empty the frames and notify every subscriber once`)
  unsubA()
  unsubB()
  publishEphemeralProgress(tick('toolA', 1))
  check('unsubscribed callbacks never fire again', wakesA === 61,
    `toolA woke ${wakesA} time(s); the function subscribeEphemeralProgress returns in src/screen/app-state/ephemeralProgressStore.ts must remove the callback`)
  _resetEphemeralProgressForTesting()
}

section('§B the ephemeral classifier (which frames belong in the store)')
{
  check('bash/powershell/mcp progress are ephemeral',
    isEphemeralToolProgress('bash_progress') &&
      isEphemeralToolProgress('powershell_progress') &&
      isEphemeralToolProgress('mcp_progress'),
    'EPHEMERAL_STORAGE_PROGRESS in src/engine/rows/storage.ts (read by isEphemeralToolProgress in src/sessions/transcripts/paths.ts) must list bash_progress, powershell_progress and mcp_progress')
  check('agent/hook/skill progress are NOT (their trails accumulate)',
    !isEphemeralToolProgress('agent_progress') &&
      !isEphemeralToolProgress('hook_progress') &&
      !isEphemeralToolProgress('skill_progress'),
    'EPHEMERAL_STORAGE_PROGRESS in src/engine/rows/storage.ts must not list agent_progress, hook_progress or skill_progress')
}


rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} PROGRESS-PROJECTION PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL PROGRESS-PROJECTION PROOFS PASS')
process.exit(0)
