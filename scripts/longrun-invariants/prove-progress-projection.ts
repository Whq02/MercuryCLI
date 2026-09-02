#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
} = await import('../../src/state/ephemeralProgressStore.js')
const { isEphemeralToolProgress } = await import('../../src/utils/sessionStorage/paths.js')

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
      .elapsedTimeSeconds === 60)
  check("only toolA's subscriber woke — 60 times", wakesA === 60, String(wakesA))
  check("toolB's subscriber NEVER woke (per-key isolation — the one-row law)", wakesB === 0, String(wakesB))

  publishEphemeralProgress(tick('toolB', 1))
  check('a toolB tick wakes toolB once and toolA not again', wakesB === 1 && wakesA === 60)

  clearEphemeralProgress()
  check('clear drops every frame and wakes every subscriber',
    getEphemeralProgressFrame('toolA') === undefined &&
      getEphemeralProgressFrame('toolB') === undefined &&
      wakesA === 61 &&
      wakesB === 2)
  unsubA()
  unsubB()
  publishEphemeralProgress(tick('toolA', 1))
  check('unsubscribed callbacks never fire again', wakesA === 61)
  _resetEphemeralProgressForTesting()
}

section('§B the ephemeral classifier (which frames belong in the store)')
{
  check('bash/powershell/mcp progress are ephemeral',
    isEphemeralToolProgress('bash_progress') &&
      isEphemeralToolProgress('powershell_progress') &&
      isEphemeralToolProgress('mcp_progress'))
  check('agent/hook/skill progress are NOT (their trails accumulate)',
    !isEphemeralToolProgress('agent_progress') &&
      !isEphemeralToolProgress('hook_progress') &&
      !isEphemeralToolProgress('skill_progress'))
}

section('§C wiring pins — the transcript never sees an ephemeral frame')
{
  const store = readFileSync(join(import.meta.dir, '..', '..', 'src', 'state', 'ephemeralProgressStore.ts'), 'utf8')
  check('the store doors stand (publish + clear still exported for the revival)',
    store.includes('export function publishEphemeralProgress(') && store.includes('export function clearEphemeralProgress('))
  const writerCensus = ((): string[] => {
    try {
      return execSync(
        "grep -rln 'publishEphemeralProgress(\\|clearEphemeralProgress(' src --include='*.ts' --include='*.tsx'",
        { encoding: 'utf8', cwd: join(import.meta.dir, '..', '..') },
      )
        .split('\n')
        .filter(f => f !== '' && f !== 'src/state/ephemeralProgressStore.ts')
    } catch {
      return []
    }
  })()
  check('the store has exactly ONE writer home — daemonConnector (the LIVEPAINT road; a second writer or a vanished one reds this for its own re-true)',
    writerCensus.length === 1 && writerCensus[0] === 'src/services/engine-connector/daemonConnector.ts',
    writerCensus.join(', '))

  const row = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'MessageRow.tsx'), 'utf8')
  check('MessageRow subscribes per-row and appends the live frame LAST',
    row.includes('useEphemeralProgressVersion(toolUseID ? [toolUseID] : [])') &&
      row.includes('return ephemeral ? [...recorded, ephemeral] : recorded'))
  const collapsed = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'messages', 'CollapsedReadSearchContent.tsx'),
    'utf8',
  )
  check('the collapsed card merges the live frame as the newest',
    collapsed.includes('useEphemeralProgressVersion(memberIds)') &&
      (collapsed.match(/getEphemeralProgressFrame\(id\) \?\?/g) ?? []).length === 2)
  const grouped = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'messages', 'GroupedToolUseContent.tsx'),
    'utf8',
  )
  check('the grouped card subscribes over its member ids and merges',
    grouped.includes('useEphemeralProgressVersion(memberIds)') &&
      grouped.includes('getEphemeralProgressFrame(id)'))
}

section('§D the F2 rider — retired with the screen-era queue surface')
{
  const importers = ((): string[] => {
    try {
      return execSync(
        "grep -rln \"from '.*useQueueProcessor\" src --include='*.ts' --include='*.tsx'",
        { encoding: 'utf8', cwd: join(import.meta.dir, '..', '..') },
      )
        .split('\n')
        .filter(f => f !== '')
    } catch {
      return []
    }
  })()
  check('EXPECTED-RETIREMENT: useQueueProcessor has no live importer — a RED means a screen-side consumer returned and the F2 law re-pins on it',
    importers.length === 0,
    importers.join(', '))
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} PROGRESS-PROJECTION PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL PROGRESS-PROJECTION PROOFS PASS')
process.exit(0)
