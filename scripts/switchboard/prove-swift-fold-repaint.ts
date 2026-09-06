#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'swift-repaint-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return pred()
}

const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
const w = await import('../../src/services/concourse/sessionWarmth.ts')

const projectDir = paths.getProjectDir(work)
mkdirSync(projectDir, { recursive: true })

const convo = (sessionId: string, text: string): string => {
  let prev: string | null = null
  const rows: Record<string, unknown>[] = []
  const row = (uuid: string, extra: Record<string, unknown>): void => {
    rows.push({
      isSidechain: false,
      entrypoint: 'cli',
      cwd: work,
      sessionId,
      version: '1.0.0-beta.1',
      gitBranch: 'main',
      parentUuid: prev,
      uuid,
      timestamp: new Date(1750000000000 + rows.length * 1000).toISOString(),
      ...extra,
    })
    prev = uuid
  }
  row(`00000000-0000-4000-8000-00000000000${sessionId.slice(-1)}`, { type: 'user', message: { role: 'user', content: `ask: ${text}` } })
  row(`00000000-0000-4000-9000-00000000000${sessionId.slice(-1)}`, {
    type: 'assistant',
    message: {
      id: `msg_${sessionId.slice(-4)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  return encodeSeedTranscript(rows, sessionId)
}

const recordFor = (sessionId: string, runnerId: string): Parameters<typeof seat.focusDaemonSession>[0] =>
  ({
    sessionId,
    runnerId,
    title: `chat ${sessionId.slice(-1)}`,
    projectLabel: 'work',
    workspaceId: work,
    home: projectDir,
  }) as never

console.log('§1 the born-session race (absent transcript → late fold repaints, honestly covered)')
{
  const sid = '11111111-1111-4111-8111-11111111111a'
  slot._resetFocusedSessionConnectorForTesting()
  w._resetSessionWarmthForTesting()
  w.armEntryWarmth(sid, 'race chat')
  const connector = await seat.focusDaemonSession(recordFor(sid, 'concourse-w1'))
  check('attach resolved on the ABSENT transcript (the paint is never held hostage)', slot.hasFocusedSession())
  check('the interim records are empty', connector.records().length === 0)
  const warmth = w.enteringWarmth()
  check(
    'the interim frame is the HONEST loading line, never blank',
    w.entryLoadingLineOf(warmth, connector.records().length === 0) === 'opening race chat — loading the conversation…',
  )
  let repainted = 0
  const off = connector.subscribeRecords(() => {
    repainted += 1
  })
  writeFileSync(join(projectDir, `${sid}.jsonl`), convo(sid, 'the late fold landed'))
  const healed = await until(() => connector.records().length > 0, 3000)
  check('the late fold repainted the MOUNTED subscription (no re-enter)', healed && repainted > 0, `repaints=${repainted} rows=${connector.records().length}`)
  check(
    'the paint selection now answers the records (the truth replaced the hint)',
    JSON.stringify(w.paintedTranscriptOf([...connector.records()], w.enteringWarmth())).includes('the late fold landed'),
  )
  check('…and the loading line stands down', w.entryLoadingLineOf(w.enteringWarmth(), connector.records().length === 0) === null)
  off()
  w.settleEntryWarmth()
}

console.log('\n§2 a subscription composed BEFORE the slot pointed hears the re-point and the fold')
{
  const sid = '22222222-2222-4222-8222-22222222222b'
  slot._resetFocusedSessionConnectorForTesting()
  let beats = 0
  const subscribeRecordsThroughSlot = slot.subscribeThroughFocused((c, listener) =>
    (c as { subscribeRecords?: (l: () => void) => () => void }).subscribeRecords?.(listener) ?? (() => {}),
  )
  const off = subscribeRecordsThroughSlot(() => {
    beats += 1
  })
  check('the early mount sees an empty resting slot', !slot.hasFocusedSession())
  writeFileSync(join(projectDir, `${sid}.jsonl`), convo(sid, 'already durable words'))
  const connector = await seat.focusDaemonSession(recordFor(sid, 'concourse-w2'))
  check('the re-point reached the early subscription', beats > 0, `beats=${beats}`)
  check('…and the records are on hand through the SAME seam', connector.records().length > 0)
  off()
}

console.log('\n§3 the last-chosen session wins; a late fold never yanks the slot')
{
  const sidA = '33333333-3333-4333-8333-33333333333c'
  const sidB = '44444444-4444-4444-8444-44444444444d'
  slot._resetFocusedSessionConnectorForTesting()
  writeFileSync(join(projectDir, `${sidB}.jsonl`), convo(sidB, 'B words'))
  const hopA = seat.focusDaemonSession(recordFor(sidA, 'concourse-w3'))
  const hopB = seat.focusDaemonSession(recordFor(sidB, 'concourse-w4'))
  await Promise.all([hopA, hopB])
  check('the slot points at the LAST chosen (B)', slot.getFocusedSessionConnector().sessionId() === sidB)
  writeFileSync(join(projectDir, `${sidA}.jsonl`), convo(sidA, 'A late words'))
  await new Promise(r => setTimeout(r, 600))
  check("A's late fold never yanked the slot", slot.getFocusedSessionConnector().sessionId() === sidB)
  check("…and B's records still paint", [...slot.getFocusedSessionConnector().records()].length > 0)
}

console.log('\n§4 warmth covers the slow fold; the landed truth replaces it')
{
  const sid = '55555555-5555-4555-8555-55555555555e'
  slot._resetFocusedSessionConnectorForTesting()
  w._resetSessionWarmthForTesting()
  const warmRow = {
    type: 'assistant',
    uuid: '00000000-0000-4000-a000-00000000ffff',
    timestamp: new Date(1750000000000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'the mirror held this tail' }] },
  }
  w.rememberSessionWarmth(sid, [warmRow] as never, 0)
  w.armEntryWarmth(sid, 'warm chat')
  const connector = await seat.focusDaemonSession(recordFor(sid, 'concourse-w5'))
  const interim = w.paintedTranscriptOf([...connector.records()], w.enteringWarmth())
  check('the interim frame carries the warm tail (no loading line beside content)', JSON.stringify(interim).includes('the mirror held this tail'))
  check('…so the loading line stays down', w.entryLoadingLineOf(w.enteringWarmth(), connector.records().length === 0) === null)
  writeFileSync(join(projectDir, `${sid}.jsonl`), convo(sid, 'the durable truth'))
  const healed = await until(() => connector.records().length > 0, 3000)
  check('the fold landed and repainted', healed)
  check(
    'the truth replaced the hint at the paint selection',
    JSON.stringify(w.paintedTranscriptOf([...connector.records()], w.enteringWarmth())).includes('the durable truth'),
  )
  const before = connector.records()
  void w.paintedTranscriptOf([...connector.records()], w.enteringWarmth(), sid)
  void w.paintedTranscriptOf([], w.enteringWarmth(), sid)
  check('warmth is render-only: the connector road is untouched by armed paints', connector.records() === before)
  check(
    '…and the armed truth-paint keeps the caller\'s array identity (no copy, no merge, no anchor shift)',
    (() => {
      const arr = [...connector.records()]
      return w.paintedTranscriptOf(arr, w.enteringWarmth(), sid) === arr
    })(),
  )
  w.evictSessionWarmth(sid)
  w.settleEntryWarmth()
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-swift-fold-repaint: ALL LAWS HOLD' : `\nprove-swift-fold-repaint: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
