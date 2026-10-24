#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const SCRATCH = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR!, 'live-counter-row-'))
delete process.env.MERCURY_HOME
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
  check(`a known empty prefill counter and its clock: ${reading}`, reading === '12s · ↓ 0', reading)
  const extended = line(facts({ wait: { ...localPromise, budgetMs: 331_000, checkedMs: 271_000 } }), T + 260_000)
  check(`an extended budget adds no narration: ${extended}`, extended === '4m 32s · ↓ 0', extended)
  const cloud = line(facts({ wait: { ...localPromise, model: 'Opus 5.5', promise: undefined, budgetMs: 120_000 } }))
  check(`the cloud road uses the same quiet row: ${cloud}`, cloud === '12s · ↓ 0', cloud)
  const thinking = line(facts({ sentAtMs: T - 40_000, firstByteAtMs: T - 38_000, thinkingChars: 3_000 }))
  check(`thinking tokens are counted once: ${thinking}`, thinking === '40s · ↓ ~750', thinking)
  const both = line(facts({ phase: 'writing', sentAtMs: T - 45_000, firstByteAtMs: T - 38_000, thinkingChars: 4_800, replyChars: 1_360 }))
  check(`thinking and reply become one total: ${both}`, both === '45s · ↓ ~1.5k', both)
  const silence = line(facts({ sentAtMs: T - 271_000, firstByteAtMs: T - 270_000 }))
  check(`unknown withheld output has no fabricated zero: ${silence}`, silence === '4m 31s', silence)
  const wire = line(facts({ phase: 'working', sentAtMs: T - 90_000, firstByteAtMs: T - 88_000, thinkingChars: 4_800, replyChars: 1_360, wireOutputTokens: 8_400 }))
  check(`the wire count once known and larger is exact: ${wire}`, wire === '1m 30s · ↓ 8.4k', wire)
  const sweep: Facts[] = []
  for (const thinkingChars of [0, 1, 3, 4, 7])
    for (const replyChars of [0, 1, 3, 4])
      for (const wireOutputTokens of [null, 0])
        for (const wait of [null, localPromise]) sweep.push(facts({ thinkingChars, replyChars, wireOutputTokens, wait }))
  const badZeros = sweep.filter(f => /↓ 0\b/.test(line(f)) && !(f.wireOutputTokens === 0 || f.replyChars === 0 && f.thinkingChars === 0 && f.firstByteAtMs === null))
  check(`${sweep.length} counter combinations only show zero when known`, badZeros.length === 0, JSON.stringify(badZeros))
  check('hidden thinking blocks are not a token count', line(facts({ thinkingBlocks: 1 })) === '12s')
  check('nonfinite counters do not create a zero', line(facts({ replyChars: NaN, thinkingChars: NaN })) === '12s')
  const oneToken = line(facts({ firstByteAtMs: T - 1_000, replyChars: 4 }))
  check(`the count appears as soon as one token is estimated: ${oneToken}`, oneToken === '12s · ↓ ~1', oneToken)
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
  check(`the total only grows across the same turn: ${totals.join(' → ')}`, totals.every((total, index) => index === 0 || total >= totals[index - 1]!))
  const secondRead = line(sequence[6]!, T + 2_000)
  check(`a later request keeps the turn count: ${secondRead}`, secondRead === '14s · ↓ 8.4k', secondRead)
  const loading = line(facts({ wait: { ...localPromise, phase: 'loading', sizeGb: 6.2 } }))
  check(`model loading does not add metadata: ${loading}`, loading === '12s · ↓ 0', loading)
  const overdue = line(facts({ wait: localPromise }), T + 300_000)
  check(`past a first-byte budget the clock still speaks alone: ${overdue}`, overdue === '5m 12s · ↓ 0', overdue)
  const retry = line(facts({ wait: { kind: 'retry', attempt: 2, of: 5, reason: 'a 529', delayMs: 3_000, sinceMs: T - 1_000 } }))
  check(`an actual retry keeps its concise indication: ${retry}`, retry === '12s · ↓ 0 · retrying 2 of 5', retry)
  const full = words.liveCounterWords(facts({ phase: 'writing', sentAtMs: T - 45_000, firstByteAtMs: T - 38_000, thinkingChars: 4_800, replyChars: 1_360, wait: { kind: 'silence', model: 'qwen3.5:9b', silentMs: 45_000, sinceMs: T - 45_000, answered: true } }), T)
  check('wide and narrow rows contain the same concise total', words.liveCounterLine(full, 173) === '45s · ↓ ~1.5k' && words.liveCounterLine(full, 40) === '45s · ↓ ~1.5k')
  check('when the total cannot fit, elapsed remains', words.liveCounterLine(full, 7) === '45s')
  check('nothing partial is painted at a width below the clock', words.liveCounterLine(full, 2) === '')
  const reconnect = words.liveCounterWords(facts({ wait: { kind: 'retry', attempt: 2, of: 5, reason: 'closed', delayMs: 0, sinceMs: T, reconnecting: true } }), T)
  check('an actual reconnection outranks counters on the narrow ladder', words.liveCounterLine(reconnect, 19) === 'reconnecting 2 of 5')
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
      hasActiveTools: false, activeToolCount: 0, activeToolLabel: null, leaderIsIdle: false,
    } as never))
const fullRow = (turn: (typeof rowFacts)[keyof typeof rowFacts], startedMs: number, columns: number): ReactNode =>
  h(SpinnerAnimationRow, {
    mode: 'thinking', reducedMotion: true, hasActiveTools: false, activeToolCount: 0, responseLengthRef: ref(turn.thinkingChars + turn.replyChars), outputTokensRef: ref<number | null>(turn.wireOutputTokens), liveTurnFactsRef: ref(turn),
    message: 'Thinking', messageColor: 'brand', shimmerColor: 'brandShimmer', overrideColor: null, loadingStartTimeRef: ref(startedMs), totalPausedMsRef: ref(0), pauseStartTimeRef: ref<number | null>(null),
    spinnerSuffix: null, verbose: true, columns, hasRunningCrewmates: false, crewmateTokens: 0, foregroundedCrewmate: undefined, leaderIsIdle: false, effortSuffix: ' (max)',
  } as never)

const frames: string[] = []
console.log('\nthe rendered rows — the compact status row and the full spinner row, at 178 and 80 columns, from planted seat facts')
for (const columns of [178, 80]) {
  const reading = await mountRow(columns, compactRow(rowFacts.reading, now - 12_000))
  frames.push(`# compact row · reading · ${columns} columns\n${reading}`)
  check(`@${columns} compact prefill keeps elapsed and known zero`, /\d+s · ↓ 0/.test(reading) && !/reading|first byte|waiting/.test(reading), reading)
  const thinking = await mountRow(columns, compactRow(rowFacts.thinking, now - 40_000))
  frames.push(`# compact row · thinking 3,000 chars · ${columns} columns\n${thinking}`)
  check(`@${columns} compact thinking keeps one estimated count`, /(?:39|4\d)s · ↓ ~750/.test(thinking) && !/thinking tokens/.test(thinking), thinking)
  const silence = await mountRow(columns, compactRow(rowFacts.silence, now - 40_000))
  frames.push(`# compact row · withheld thinking · ${columns} columns\n${silence}`)
  check(`@${columns} compact withheld output keeps elapsed, never an invented zero`, /(?:39|4\d)s/.test(silence) && !silence.includes('↓'), silence)
  const fullReading = await mountRow(columns, fullRow(rowFacts.reading, now - 12_000, columns))
  frames.push(`# full row · reading · ${columns} columns\n${fullReading}`)
  check(`@${columns} full prefill keeps known zero without phase or effort words`, fullReading.includes('↓ 0') && !/reading|waiting|thinking \(max\)/.test(fullReading), fullReading)
  const fullThinking = await mountRow(columns, fullRow(rowFacts.thinking, now - 40_000, columns))
  frames.push(`# full row · thinking 3,000 chars · ${columns} columns\n${fullThinking}`)
  check(`@${columns} full thinking keeps the total without a phase label`, fullThinking.includes('↓ ~750') && !/thinking tokens|thinking \(max\)/.test(fullThinking), fullThinking)
}
if (FRAMES !== undefined) {
  mkdirSync(FRAMES, { recursive: true })
  writeFileSync(join(FRAMES, 'live-counter-rows.txt'), `${frames.join('\n\n')}\n`)
  console.log(`frames written to ${join(FRAMES, 'live-counter-rows.txt')}`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS live counter: quiet rows, honest counts' : `\nFAIL live counter: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
