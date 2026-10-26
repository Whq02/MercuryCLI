#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { pinScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'
import { AnsiEmulator } from './ansiEmulator.js'

const home = pinScratchHome('wizard-step')
delete process.env.NODE_ENV
const DEAD = 'http://127.0.0.1:9'
Object.assign(process.env, {
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_REDUCED_MOTION: '1',
  BROWSER: 'true',
  ANTHROPIC_BASE_URL: DEAD,
  MERCURY_OPENAI_API_BASE: DEAD,
  MERCURY_OPENAI_CHATGPT_BASE: DEAD,
  MERCURY_OPENAI_AUTH_BASE: DEAD,
  MERCURY_OPENROUTER_API_BASE: DEAD,
  MERCURY_OPENROUTER_AUTH_BASE: DEAD,
  MERCURY_GEMINI_API_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
  MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
  MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
  MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
  MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
  MERCURY_DEEPSEEK_API_BASE: DEAD,
})
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MERCURY_OAUTH_TOKEN|MERCURY_API_KEY_FILE_DESCRIPTOR|OPENAI_API_KEY|ZAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|MOONSHOT_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|XAI_API_KEY|MODEL_API_KEY|MERCURY_COMPAT_BASE_URL|MERCURY_LOCAL_BASE_URL|TERM_PROGRAM|TERM_PROGRAM_VERSION|WT_SESSION|CURSOR_TRACE_ID|VSCODE_GIT_ASKPASS_MAIN|__CFBundleIdentifier|VisualStudioVersion|TERMINAL_EMULATOR|TMUX|MERCURY_FULLSCREEN)$/.test(key)) delete process.env[key]
}

const { default: Ink } = await import('../../src/ink/ink.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { disposeKeybindingWatcher } = await import('../../src/keybindings/loadUserBindings.js')
const { Onboarding } = await import('../../src/components/Onboarding.js')

const COLS = 80
const ROWS = 24
const IDLE_GAP_MS = 31_000
const PROBE_CSI = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g
const WIDTH_PROBE_WRITE = /\x1b7.*\x1b\[6n/s

let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}

class Output extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  writes: string[] = []
  write(s: string): boolean {
    this.writes.push(s)
    return true
  }
}

class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  private chunks: string[] = []
  setEncoding(): this { return this }
  setRawMode(v: boolean): this { this.isRaw = v; return this }
  ref(): this { return this }
  unref(): this { return this }
  pause(): this { return this }
  resume(): this { return this }
  read(): string | null { return this.chunks.shift() ?? null }
  get readableLength(): number { return this.chunks.reduce((n, c) => n + c.length, 0) }
  push(data: string): void {
    this.chunks.push(data)
    this.emit('readable')
  }
}

const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew

const h = React.createElement

function glass(stdout: Output): string[] {
  const terminal = new AnsiEmulator(COLS, ROWS, true)
  for (const bytes of stdout.writes) {
    if (WIDTH_PROBE_WRITE.test(bytes)) continue
    terminal.feed(bytes.replace(PROBE_CSI, ''))
  }
  return terminal.lines()
}

function composed(ink: InstanceType<typeof Ink>): string[] {
  const lines = stripAnsi(ink.lastFrameText()).split('\n').map(line => line.trimEnd())
  while (lines.length < ROWS) lines.push('')
  return lines.slice(0, ROWS)
}

function differing(got: string[], want: string[]): string {
  return got.flatMap((line, y) => (line === want[y] ? [] : [`row ${y}: ${JSON.stringify(line)} != ${JSON.stringify(want[y])}`])).slice(0, 3).join(' | ')
}

async function walk(road: 'active' | 'idle'): Promise<void> {
  console.log(`\n§ ${road === 'idle' ? 'each step key arrives after a quiet gap longer than 30 s (the renderer resets its diff base first)' : 'each step key arrives while the renderer is warm'}`)
  const stdout = new Output()
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.setAltScreenActive(true, false)
  ink.render(h(AppStateProvider as never, { onChangeAppState: () => {} } as never, h(KeybindingSetup as never, {} as never, h(Onboarding as never, { onDone: () => {} } as never))))
  const sees = (needle: RegExp): Promise<boolean> => waitFor(() => needle.test(composed(ink).join('\n')), 20_000)

  const themeUp = await sees(/Choose your theme/)
  await settle(300)
  check(`${road}: step 1 (theme) paints`, themeUp, composed(ink).slice(0, 4).join(' / '))
  check(`${road}: step 1 on the glass equals the frame the renderer composed`, JSON.stringify(glass(stdout)) === JSON.stringify(composed(ink)), differing(glass(stdout), composed(ink)))

  if (road === 'idle') skew += IDLE_GAP_MS
  stdin.push('\r')
  const signInUp = await sees(/sign in · 2\/\d/)
  await settle(400)
  const afterTwo = glass(stdout)
  check(`${road}: step 2 (sign in) paints`, signInUp, composed(ink).slice(0, 4).join(' / '))
  check(`${road}: step 2 on the glass equals the frame the renderer composed (no cell of step 1 left under it)`, JSON.stringify(afterTwo) === JSON.stringify(composed(ink)), differing(afterTwo, composed(ink)))
  check(`${road}: no word of the theme card survives in the sign-in card`, !afterTwo.some(line => /Choose your theme|theme · 1\/\d|preview · ↵ keep/.test(line)), afterTwo.filter(line => /Choose your theme|theme · 1\/\d|preview · ↵ keep/.test(line)).slice(0, 2).join(' | '))

  if (road === 'idle') skew += IDLE_GAP_MS
  stdin.push('s')
  const guardUp = await sees(/guardrails · 3\/\d/)
  await settle(400)
  const afterThree = glass(stdout)
  check(`${road}: step 3 (guardrails) paints`, guardUp, composed(ink).slice(0, 4).join(' / '))
  check(`${road}: step 3 on the glass equals the frame the renderer composed (no cell of steps 1-2 left under it)`, JSON.stringify(afterThree) === JSON.stringify(composed(ink)), differing(afterThree, composed(ink)))

  if (failures > 0) {
    console.log(`  glass after step 2 (${road}):`)
    for (const line of afterTwo.slice(0, 12)) console.log(`    |${line}`)
  }
  ink.unmount()
  instances.delete(stdout as never)
  await settle(50)
}

console.log('first-run wizard at 80x24 on the alternate screen — each step replaces every cell of the one before')
await walk('active')
await walk('idle')
Date.now = realNow
disposeKeybindingWatcher()
rmSync(home, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '[PASS]' : '[FAIL]'} wizard step replaces cells: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
