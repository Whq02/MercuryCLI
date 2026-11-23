#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'store-fail-window-'))
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
mkdirSync(daemonDir, { recursive: true })
mkdirSync(work, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME

const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
const proj = await import('../../src/engine/connector/seatProjections.ts')
const seatWire = await import('../../src/engine/connector/seatWire.ts')

let failures = 0
let checks = 0
let where = 'the transcriptStoreFailing key of FACTS_SPEC in src/engine/connector/seatWire.ts'
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}${ok ? '' : ` — to change: ${where}`}`)
}
const section = (t: string): void => {
  if (t.startsWith('§2')) where = 'transcriptStoreFailing() and wake() of the facts part in src/engine/connector/daemon/facts.ts, reached through DaemonSessionConnector in src/engine/connector/daemonConnector.ts'
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? 'undefined'

const SENTENCE = "EISDIR: illegal operation on a directory, open '/the/session/record.jsonl'"
const baseAnswer = {
  model: { effective: 'claude-sonnet-5-5', setting: null },
  usage: {
    totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0,
    hasUnknownModelCost: false,
  },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'default' as const,
  workspace: { cwd: work, originalCwd: work, projectRoot: work, instructionRoots: [] },
  queue: [],
}

try {
  section('§1 the wire: the runner tells the store\'s sentence in its session facts under one name, and only while the store fails')
  {
    const failing = seatWire.sessionFactsToWire({ ...baseAnswer, transcriptStoreFailing: SENTENCE } as never)
    check('the answer of a runner whose store fails carries the sentence as transcript_store_failing', failing.transcript_store_failing === SENTENCE && !('transcriptStoreFailing' in failing), j(Object.keys(failing).filter(key => /store/i.test(key))))
    check('the host reads it back', seatWire.sessionFactsFromWire(failing)?.transcriptStoreFailing === SENTENCE, j(seatWire.sessionFactsFromWire(failing)?.transcriptStoreFailing))
    const well = seatWire.sessionFactsToWire(baseAnswer as never)
    check('an answer with a store that writes carries no such key', !('transcript_store_failing' in well) && seatWire.sessionFactsFromWire(well)?.transcriptStoreFailing === undefined, j(Object.keys(well)))
  }

  section('§2 the window\'s connector: the facts the daemon publishes for the session are where the window hears it')
  {
    const sid = 'store-fail-window-a'
    let factsFeedReads: () => void = () => {}
    const connector = new DaemonSessionConnector({ sessionId: sid, runnerId: `runner-${sid}`, title: 'the chat', projectLabel: 'proof', workspaceId: work, home: SCRATCH, modelKey: 'claude-sonnet-5-5' } as never, {
      factsRead: (read: () => void) => {
        factsFeedReads = read
      },
    })
    const hears = connector as unknown as { transcriptStoreFailing?: () => string | null; subscribeModel: (listener: () => void) => () => void }
    const heard: Array<string | null> = []
    const off = hears.subscribeModel(() => { heard.push(hears.transcriptStoreFailing?.() ?? null) })
    const publish = (atMs: number, extra: Record<string, unknown>): void => {
      proj.publishSessionFacts({ schema: 1, sessionId: sid, atMs, pendingModel: null, busy: false, ...baseAnswer, ...extra } as never, daemonDir)
      factsFeedReads()
    }
    const t0 = Date.now()
    publish(t0, {})
    check('a session whose store writes: the connector tells no sentence', hears.transcriptStoreFailing !== undefined && hears.transcriptStoreFailing() === null, j(hears.transcriptStoreFailing?.()))
    const before = heard.length
    publish(t0 + 1_000, { transcriptStoreFailing: SENTENCE })
    check("the runner's facts carry the sentence: the connector tells it", hears.transcriptStoreFailing?.() === SENTENCE, j(hears.transcriptStoreFailing?.()))
    check('…and tells its listeners at that facts update, though nothing else in the facts moved (the window repaints its notice on this)', heard.length > before && heard.at(-1) === SENTENCE, j(heard))
    publish(t0 + 2_000, { transcriptStoreFailing: '' })
    check('a store that fails with no sentence of its own is still told, as an empty one (the window has its own words for it)', hears.transcriptStoreFailing?.() === '', j(hears.transcriptStoreFailing?.()))
    const mid = heard.length
    publish(t0 + 3_000, {})
    check('the store answers again: the connector tells no sentence, and its listeners hear that too', hears.transcriptStoreFailing?.() === null && heard.length > mid && heard.at(-1) === null, j(heard))
    off()
  }

} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'hosted-window-hears-the-store-fail: ALL LAWS HOLD' : `hosted-window-hears-the-store-fail: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
