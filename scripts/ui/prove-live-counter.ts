#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReactNode } from 'react'
import stripAnsi from 'strip-ansi'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(arg('--root') ?? join(import.meta.dir, '..', '..'))
const framesArg = arg('--frames')
const FRAMES = framesArg === undefined ? undefined : resolve(framesArg)

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'live-counter-row-'))
mkdirSync(join(SCRATCH, 'home'), { recursive: true })
mkdirSync(join(SCRATCH, 'project'), { recursive: true })
process.chdir(join(SCRATCH, 'project'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.BROWSER = '/usr/bin/true'

const mod = async <T>(rel: string): Promise<T> => (await import(join(ROOT, rel))) as T
const reactModule = await mod<{ default?: typeof import('react') } & typeof import('react')>('node_modules/react/index.js')
const React = reactModule.default ?? reactModule
const { default: Ink } = await mod<typeof import('../../src/ink/ink.tsx')>('src/ink/ink.tsx')
const { App } = await mod<typeof import('../../src/components/App.tsx')>('src/components/App.tsx')
const { getDefaultAppState } = await mod<typeof import('../../src/state/AppStateStore.ts')>('src/state/AppStateStore.ts')
const { SpinnerWithVerb } = await mod<typeof import('../../src/components/Spinner.tsx')>('src/components/Spinner.tsx')
const { SpinnerAnimationRow } = await mod<typeof import('../../src/components/Spinner/SpinnerAnimationRow.tsx')>('src/components/Spinner/SpinnerAnimationRow.tsx')
const { enableConfigs } = await mod<typeof import('../../src/utils/config.ts')>('src/utils/config.ts')
const { default: instances } = await mod<typeof import('../../src/ink/instances.ts')>('src/ink/instances.ts')
const focusedSlot = await mod<typeof import('../../src/services/engine-connector/focusedConnector.ts')>('src/services/engine-connector/focusedConnector.ts')
const { noSessionConnector } = await mod<typeof import('../../src/services/engine-connector/noSessionConnector.ts')>('src/services/engine-connector/noSessionConnector.ts')
type Words = typeof import('../../src/components/Spinner/liveCounterWords.ts')
const words = await mod<Words>('src/components/Spinner/liveCounterWords.ts').catch(() => null)
type Facts = import('../../src/components/Spinner/liveCounterWords.ts').LiveCounterFacts
type Wait = import('../../src/services/providers/streamIdleBudget.ts').RequestWaitV1

enableConfigs()
focusedSlot.setFocusedSessionConnector(noSessionConnector())
const h = React.createElement
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const hardLimit = setTimeout(() => { console.error('live counter proof exceeded its deadline'); process.exit(1) }, 90_000)
hardLimit.unref()

const T = 1_800_000_000_000
const localPromise: Wait = { kind: 'first-byte', cold: true, promptTokens: 65_000, model: 'qwen3.5:9b', budgetMs: 271_000, sinceMs: T - 12_000, attempt: 1, promise: true }
const facts = (over: Partial<Facts>): Facts => ({ phase: 'thinking', sentAtMs: T - 12_000, firstByteAtMs: null, replyChars: 0, thinkingChars: 0, wireOutputTokens: null, wait: null, ...over })
const line = (f: Facts, now = T): string => (words === null ? '' : words.liveCounterSegments(words.liveCounterWords(f, now)).join(' · '))

console.log('the words function — the live facts become the row\'s words in one place')
check('the row has ONE words function (src/components/Spinner/liveCounterWords.ts) turning sent-at, first-byte-at, reply chars, thinking chars, the wire count and the promise into its words', words !== null)
if (words !== null) {
  const reading = line(facts({ wait: localPromise }))
  check(`sent, no byte, the local promise ⇒ reading with the clock and the promise: ${reading}`, reading === 'reading the prompt · 12s · first byte expected within 4m 31s', reading)
  const extended = line(facts({ wait: { ...localPromise, budgetMs: 331_000, checkedMs: 271_000 } }), T + 260_000)
  check(`the liveness probe extended the promise ⇒ the row promises the extended budget: ${extended}`, extended === 'reading the prompt · 4m 32s · first byte expected within 5m 31s', extended)
  const cloud = line(facts({ wait: { ...localPromise, model: 'Opus 5.5', promise: undefined, budgetMs: 120_000 } }))
  check(`a cloud road's first-byte wait reads the prompt with its own budget: ${cloud}`, cloud === 'reading the prompt · 12s · first byte expected within 2m', cloud)
  const thinking = line(facts({ sentAtMs: T - 40_000, firstByteAtMs: T - 38_000, thinkingChars: 3_000 }))
  check(`thinking 3,000 chars, no reply ⇒ the thinking tokens counted beside the clock: ${thinking}`, thinking === '↓ ~750 thinking tokens · thinking · 40s', thinking)
  const both = line(facts({ phase: 'writing', sentAtMs: T - 45_000, firstByteAtMs: T - 38_000, thinkingChars: 4_800, replyChars: 1_360 }))
  check(`thinking then reply ⇒ both counts in the shortest form: ${both}`, both === '↓ ~1.2k thinking · 340 tokens · writing · 45s', both)
  const silence = line(facts({ sentAtMs: T - 271_000, firstByteAtMs: T - 270_000 }))
  check(`a withheld-thinking silence ⇒ the clock only, never a still 0: ${silence}`, silence === 'thinking · 4m 31s', silence)
  const wire = line(facts({ phase: 'working', sentAtMs: T - 90_000, firstByteAtMs: T - 88_000, thinkingChars: 4_800, replyChars: 1_360, wireOutputTokens: 8_400 }))
  check(`the wire count once known and larger ⇒ the exact figure, no ~: ${wire}`, wire === '↓ 8.4k tokens · working · 1m 30s', wire)
  const sweep: Facts[] = []
  for (const thinkingChars of [0, 1, 3, 4, 7])
    for (const replyChars of [0, 1, 3, 4])
      for (const wireOutputTokens of [null, 0])
        for (const wait of [null, localPromise]) sweep.push(facts({ thinkingChars, replyChars, wireOutputTokens, wait }))
  const zeros = sweep.map(f => line(f)).filter(text => /↓ ~?0\b/.test(text) || /\b0 tokens?\b/.test(text))
  check(`never a ↓ 0: ${sweep.length} planted fact sets paint no zero count`, zeros.length === 0, zeros.join(' | '))
  const oneToken = line(facts({ firstByteAtMs: T - 1_000, replyChars: 4 }))
  check(`the count appears the moment a token exists: ${oneToken}`, oneToken === '↓ ~1 token · thinking · 12s', oneToken)
  const sequence: Facts[] = [
    facts({ wait: localPromise }),
    facts({ firstByteAtMs: T - 1_000 }),
    facts({ firstByteAtMs: T - 1_000, thinkingChars: 500 }),
    facts({ firstByteAtMs: T - 1_000, thinkingChars: 3_000 }),
    facts({ phase: 'writing', firstByteAtMs: T - 1_000, thinkingChars: 3_000, replyChars: 800 }),
    facts({ phase: 'working', firstByteAtMs: T - 1_000, thinkingChars: 3_000, replyChars: 800, wireOutputTokens: 8_400 }),
    facts({ wait: { ...localPromise, attempt: 1, sinceMs: T }, thinkingChars: 3_000, replyChars: 800, wireOutputTokens: 8_400 }),
    facts({ firstByteAtMs: T + 3_000, thinkingChars: 3_200, replyChars: 800, wireOutputTokens: 8_400 }),
    facts({ phase: 'writing', firstByteAtMs: T + 3_000, thinkingChars: 30_000, replyChars: 4_000, wireOutputTokens: 8_400 }),
  ]
  const totals = sequence.map(f => words.liveCounterWords(f, T + 5_000).figure.total)
  check(`after the first byte the count only grows across a turn (reading → thinking → reply → wire → next request): ${totals.join(' → ')}`, totals.every((total, index) => index === 0 || total >= totals[index - 1]!))
  const secondRead = line(sequence[6]!, T + 2_000)
  check(`a later request in the same turn reads the prompt with the count it already has: ${secondRead}`, secondRead === '↓ 8.4k tokens · reading the prompt · 14s · first byte expected within 4m 31s', secondRead)
  const loading = line(facts({ wait: { ...localPromise, phase: 'loading', sizeGb: 6.2 } }))
  check(`the local road's model load speaks its own phase: ${loading}`, loading === 'loading the model · 12s · qwen3.5:9b (6.2 GB)', loading)
  const overdue = line(facts({ wait: localPromise }), T + 300_000)
  check(`past the first-byte budget the promise says so instead of promising: ${overdue}`, overdue === 'reading the prompt · 5m 12s · past the 4m 31s first-byte budget', overdue)
  const retry = line(facts({ wait: { kind: 'retry', attempt: 2, of: 5, reason: 'a 529', delayMs: 3_000, sinceMs: T - 1_000 } }))
  check(`a reissue on its way speaks the retry, never a dead 0: ${retry}`, retry === 'retrying · 12s · attempt 2 of 5 after a 529 · in 3s', retry)
  const full = words.liveCounterWords(facts({ phase: 'writing', sentAtMs: T - 45_000, firstByteAtMs: T - 38_000, thinkingChars: 4_800, replyChars: 1_360, wait: { kind: 'silence', model: 'qwen3.5:9b', silentMs: 45_000, sinceMs: T - 45_000, answered: true } }), T)
  const wide = words.liveCounterLine(full, 173)
  const tight = words.liveCounterLine(full, 40)
  const tighter = words.liveCounterLine(full, 22)
  const tightest = words.liveCounterLine(full, 6)
  check(`the width law at 178 columns keeps every segment: ${wide}`, wide === '↓ ~1.2k thinking · 340 tokens · writing · 45s · no bytes for 45s — the server still answers', wide)
  check(`a tight row sheds the promise first and the long count next: ${tight}`, tight === '↓ ~1.5k tokens · writing · 45s', tight)
  check(`tighter keeps the count and the clock: ${tighter}`, tighter === '↓ ~1.5k tokens · 45s', tighter)
  check(`the clock is the last word to go: ${tightest}`, tightest === '45s', tightest)
}

class Output extends EventEmitter {
  isTTY = true
  rows = 40
  constructor(public columns: number) { super() }
  write(): boolean { return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): string | null { return null }
  get readableLength(): number { return 0 }
}
const ref = <V,>(current: V) => ({ current })
async function mountRow(columns: number, node: ReactNode): Promise<string> {
  const stdout = new Output(columns)
  const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(columns) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(node)
  await sleep(350)
  const frame = stripAnsi(ink.lastFrameText()).split('\n').map(row => row.trimEnd()).filter(row => row !== '').join('\n')
  ink.unmount()
  instances.delete(stdout as never)
  return frame
}
const now = Date.now()
const rowFacts = {
  reading: { replyChars: 0, thinkingChars: 0, wireOutputTokens: null, firstByteAtMs: null, wait: { ...localPromise, sinceMs: now - 12_000 } },
  thinking: { replyChars: 0, thinkingChars: 3_000, wireOutputTokens: null, firstByteAtMs: now - 38_000, wait: null },
  silence: { replyChars: 0, thinkingChars: 0, wireOutputTokens: null, firstByteAtMs: now - 38_000, wait: null },
} as const
const compactRow = (turn: (typeof rowFacts)[keyof typeof rowFacts], startedMs: number): ReactNode =>
  h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined },
    h(SpinnerWithVerb, {
      compact: true, compactWarning: false, mode: 'thinking', loadingStartTimeRef: ref(startedMs), totalPausedMsRef: ref(0), pauseStartTimeRef: ref<number | null>(null),
      spinnerTip: null, responseLengthRef: ref(turn.thinkingChars + turn.replyChars), outputTokensRef: ref<number | null>(turn.wireOutputTokens), liveTurnFactsRef: ref(turn),
      overrideColor: null, overrideShimmerColor: null, overrideMessage: 'Thinking', still: false, spinnerSuffix: null, verbose: false,
      hasActiveTools: false, activeToolCount: 0, activeToolLabel: null, leaderIsIdle: false, apiMetricsRef: ref([]),
    } as never))
const fullRow = (turn: (typeof rowFacts)[keyof typeof rowFacts], startedMs: number, columns: number): ReactNode =>
  h(SpinnerAnimationRow, {
    mode: 'thinking', reducedMotion: true, hasActiveTools: false, activeToolCount: 0, responseLengthRef: ref(turn.thinkingChars + turn.replyChars), outputTokensRef: ref<number | null>(turn.wireOutputTokens), liveTurnFactsRef: ref(turn),
    message: 'Thinking', messageColor: 'claude', shimmerColor: 'claudeShimmer', overrideColor: null, loadingStartTimeRef: ref(startedMs), totalPausedMsRef: ref(0), pauseStartTimeRef: ref<number | null>(null),
    spinnerSuffix: null, verbose: true, columns, hasRunningCrewmates: false, crewmateTokens: 0, foregroundedCrewmate: undefined, leaderIsIdle: false, effortSuffix: ' (max)',
  } as never)

const frames: string[] = []
console.log('\nthe rendered rows — the compact status row and the full spinner row, at 178 and 80 columns, from planted seat facts')
for (const columns of [178, 80]) {
  const reading = await mountRow(columns, compactRow(rowFacts.reading, now - 12_000))
  frames.push(`# compact row · reading · ${columns} columns\n${reading}`)
  check(`@${columns} compact, sent and no byte: no dead ↓ 0 tokens on the row (${reading.replace(/\n/g, ' ↵ ')})`, !/↓ ~?0 tokens/.test(reading), reading)
  check(`@${columns} compact, sent and no byte: the row says it is reading the prompt with the clock ticking`, /reading the prompt · \d+s/.test(reading), reading)
  check(`@${columns} compact, sent and no byte: the local road's promise rides the row`, /first byte expected within 4m 31s/.test(reading), reading)
  const thinking = await mountRow(columns, compactRow(rowFacts.thinking, now - 40_000))
  frames.push(`# compact row · thinking 3,000 chars · ${columns} columns\n${thinking}`)
  check(`@${columns} compact, thinking 3,000 chars and no reply: the thinking tokens are counted (${thinking.replace(/\n/g, ' ↵ ')})`, /↓ ~750 thinking tokens · thinking · (39|4\d)s/.test(thinking), thinking)
  const silence = await mountRow(columns, compactRow(rowFacts.silence, now - 40_000))
  frames.push(`# compact row · withheld thinking · ${columns} columns\n${silence}`)
  check(`@${columns} compact, a withheld-thinking silence: the clock alone moves, never a still 0 (${silence.replace(/\n/g, ' ↵ ')})`, /thinking · (39|4\d)s/.test(silence) && !/↓ ~?0 tokens/.test(silence), silence)
  const fullReading = await mountRow(columns, fullRow(rowFacts.reading, now - 12_000, columns))
  frames.push(`# full row · reading · ${columns} columns\n${fullReading}`)
  check(`@${columns} full row, sent and no byte: reading the prompt, no dead ↓ 0 tokens (${fullReading.replace(/\n/g, ' ↵ ')})`, /reading the prompt/.test(fullReading) && !/↓ ~?0 tokens/.test(fullReading) && !/thinking \(max\)/.test(fullReading), fullReading)
  const fullThinking = await mountRow(columns, fullRow(rowFacts.thinking, now - 40_000, columns))
  frames.push(`# full row · thinking 3,000 chars · ${columns} columns\n${fullThinking}`)
  check(`@${columns} full row, thinking 3,000 chars: the thinking tokens are counted beside the thinking label (${fullThinking.replace(/\n/g, ' ↵ ')})`, /↓ ~750 thinking tokens/.test(fullThinking) && /thinking \(max\)/.test(fullThinking), fullThinking)
}
if (FRAMES !== undefined) {
  mkdirSync(FRAMES, { recursive: true })
  writeFileSync(join(FRAMES, 'live-counter-rows.txt'), `${frames.join('\n\n')}\n`)
  console.log(`frames written to ${join(FRAMES, 'live-counter-rows.txt')}`)
}

console.log(failures === 0 ? '\n✅ live counter GREEN — reading ticks, thinking counts, never a dead 0' : `\n❌ live counter RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
