#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReactNode } from 'react'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(arg('--root') ?? join(import.meta.dir, '..', '..'))

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'thinking-shimmer-quiet-'))
mkdirSync(join(SCRATCH, 'home'), { recursive: true })
mkdirSync(join(SCRATCH, 'project'), { recursive: true })
process.chdir(join(SCRATCH, 'project'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.BROWSER = '/usr/bin/true'
process.env.FORCE_COLOR = '3'

const mod = async <T>(rel: string): Promise<T> => (await import(join(ROOT, rel))) as T
const reactModule = await mod<{ default?: typeof import('react') } & typeof import('react')>('node_modules/react/index.js')
const React = reactModule.default ?? reactModule
const { default: Ink } = await mod<typeof import('../../src/ink/ink.tsx')>('src/ink/ink.tsx')
const { SpinnerAnimationRow } = await mod<typeof import('../../src/components/Spinner/SpinnerAnimationRow.tsx')>('src/components/Spinner/SpinnerAnimationRow.tsx')
const { enableConfigs } = await mod<typeof import('../../src/utils/config.ts')>('src/utils/config.ts')
const { default: instances } = await mod<typeof import('../../src/ink/instances.ts')>('src/ink/instances.ts')
const focusedSlot = await mod<typeof import('../../src/services/engine-connector/focusedConnector.ts')>('src/services/engine-connector/focusedConnector.ts')
const { noSessionConnector } = await mod<typeof import('../../src/services/engine-connector/noSessionConnector.ts')>('src/services/engine-connector/noSessionConnector.ts')
enableConfigs()
focusedSlot.setFocusedSessionConnector(noSessionConnector())
const h = React.createElement
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const hardLimit = setTimeout(() => { console.error('thinking shimmer proof exceeded its deadline'); process.exit(1) }, 60_000)
hardLimit.unref()

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
  pause(): this { return this }
  resume(): this { return this }
}
const ref = <T>(value: T): { current: T } => ({ current: value })
const now = Date.now()
const facts = { replyChars: 0, thinkingChars: 3_000, wireOutputTokens: null, firstByteAtMs: now - 8_000, wait: null }
const row = (reducedMotion: boolean, mode: 'thinking' | 'responding' = 'thinking'): ReactNode =>
  h(SpinnerAnimationRow, {
    mode, reducedMotion, hasActiveTools: false, activeToolCount: 0, responseLengthRef: ref(3_000), outputTokensRef: ref<number | null>(null), liveTurnFactsRef: ref(facts),
    message: 'Thinking', messageColor: 'claude', shimmerColor: 'claudeShimmer', overrideColor: null, loadingStartTimeRef: ref(now - 8_000), totalPausedMsRef: ref(0), pauseStartTimeRef: ref<number | null>(null),
    spinnerSuffix: null, verbose: true, columns: 120, hasRunningCrewmates: false, crewmateTokens: 0, foregroundedCrewmate: undefined, leaderIsIdle: false, effortSuffix: ' (max)',
  } as never)

const labelInk = (raw: string): string | null => {
  const at = raw.indexOf('thinking (max)')
  if (at < 0) return null
  const before = raw.slice(Math.max(0, at - 64), at)
  const sgr = [...before.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
  const last = sgr[sgr.length - 1]
  return last === undefined ? null : `${last[1]},${last[2]},${last[3]}`
}
async function mountAndSample(reducedMotion: boolean, samplesMs: number[], respondingFirstMs = 0): Promise<Array<string | null>> {
  const stdout = new Output(120)
  const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(120) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  if (respondingFirstMs > 0) {
    ink.render(row(reducedMotion, 'responding'))
    await sleep(respondingFirstMs)
  }
  ink.render(row(reducedMotion, 'thinking'))
  const out: Array<string | null> = []
  let elapsed = 0
  for (const at of samplesMs) {
    await sleep(at - elapsed)
    elapsed = at
    out.push(labelInk(ink.lastFrameText()))
  }
  ink.unmount()
  instances.delete(stdout as never)
  return out
}

console.log('the thinking label holds its colour for the first three seconds of EACH think, however long the row has been up')
const [quiet] = await mountAndSample(true, [400])
check('the still reference: a reduced-motion think paints the label in the thinking colour', quiet !== null, 'no thinking label ink found')
const [early, late1, late2] = await mountAndSample(false, [400, 3_900, 4_250], 3_600)
check(`a think that begins 3.6 s into the turn (the row was responding) is quiet at first: its label wears the thinking colour at 0.4 s (${early})`, early !== null && early === quiet, `early ${early} · quiet ${quiet}`)
check(`…and shimmers once the think itself is three seconds old (3.9 s ${late1} · 4.25 s ${late2})`, late1 !== null && late2 !== null && (late1 !== quiet || late2 !== quiet), `quiet ${quiet}`)

console.log(failures === 0 ? '\n✅ thinking shimmer quiet GREEN — three still seconds per think' : `\n❌ thinking shimmer quiet RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
