#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const proj = await import('../../src/services/engine-connector/seatProjections.ts')
const seatWire = await import('../../src/services/engine-connector/seatWire.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (t: string): void => {
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
    const connector = new DaemonSessionConnector({ sessionId: sid, runnerId: `runner-${sid}`, title: 'the chat', projectLabel: 'proof', workspaceId: work, home: SCRATCH, modelKey: 'claude-sonnet-5-5' } as never)
    const g = connector as unknown as { readFacts: () => void }
    const hears = connector as unknown as { transcriptStoreFailing?: () => string | null; subscribeModel: (listener: () => void) => () => void }
    const heard: Array<string | null> = []
    const off = hears.subscribeModel(() => { heard.push(hears.transcriptStoreFailing?.() ?? null) })
    const publish = (atMs: number, extra: Record<string, unknown>): void => {
      proj.publishSessionFacts({ schema: 1, sessionId: sid, atMs, pendingModel: null, busy: false, ...baseAnswer, ...extra } as never, daemonDir)
      g.readFacts()
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

  section('§3 the window: the one notice it raises for a failing store reads both stores (read from the source; the effect is not mounted here)')
  {
    const chat = readFileSync(join(import.meta.dir, '..', '..', 'src', 'screens', 'Chat.tsx'), 'utf8')
    const at = chat.indexOf("key: 'transcript-store'")
    const effect = at === -1 ? '' : chat.slice(chat.lastIndexOf('useEffect(', at), chat.indexOf('}, [', at) + 40)
    check('Chat.tsx raises the transcript-store notice in one place', at !== -1 && chat.indexOf("key: 'transcript-store'", at + 1) === -1)
    check("that effect reads this process's store and the focused connector's sentence, and repaints on either", effect.includes('transcriptStoreHealth()') && effect.includes('transcriptStoreFailing') && effect.includes('subscribeTranscriptStoreHealth(paint)') && effect.includes('subscribeModel(paint)') && effect.includes('[focusedConnector]'), effect.slice(0, 400))
    const seat = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'sessionSeat.ts'), 'utf8')
    check("the daemon publishes the runner's whole answer as the session's facts, and asks for them when the runner speaks a notice", /const \{ box: boxAnswer, \.\.\.answerRest \} = answer/.test(seat) && /\.\.\.answerRest,/.test(seat) && /case 'notice':\s*\n\s*requestSessionFacts\(short, roster, undefined, dir\)/.test(seat))
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'hosted-window-hears-the-store-fail: ALL LAWS HOLD' : `hosted-window-hears-the-store-fail: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
