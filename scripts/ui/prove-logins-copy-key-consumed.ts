#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = mkdtempSync(join(tmpdir(), 'mercury-logins-copy-unit-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.FORCE_COLOR = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.BROWSER = existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true'
process.env.SSH_CONNECTION = 'proof'
for (const key of [
  'TMUX',
  'LC_TERMINAL',
  'SSH_CLIENT',
  'SSH_TTY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_TOKEN',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
]) {
  delete process.env[key]
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const React = await import('react')
const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')
const { subscribeClipboardReceipts } = await import('../../src/screen/renderer/termio/osc.js')
const { BootLoginsScreen } = await import('../../src/screen/boot-face/BootLoginsScreen.js')
const { ConsoleOAuthFlow } = await import('../../src/models/sign-in/flow-cards/SignInFlow.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { signedOutFacts } = await import('./face-logins-stills.ts')

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const COLS = 120
const ROWS = 80
class FakeStdout extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  writes: string[] = []
  write(s: string): boolean {
    this.writes.push(s)
    return true
  }
}
class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  private chunks: string[] = []
  setEncoding(): this {
    return this
  }
  setRawMode(v: boolean): this {
    this.isRaw = v
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  read(): string | null {
    return this.chunks.shift() ?? null
  }
  get readableLength(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0)
  }
  push(data: string): void {
    this.chunks.push(data)
    this.emit('readable')
  }
}

type Mounted = { push: (data: string) => void; screen: () => string; unmount: () => void }
const PROBE_CSI = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g
const emulatorRefusals: string[] = []
function mount(element: React.ReactElement): Mounted {
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const ink = new ScreenInstance({
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStdout() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(stdout as never, ink)
  ink.render(element)
  return {
    push: data => stdin.push(data),
    screen: () => {
      const emu = new AnsiEmulator(COLS, ROWS, false)
      for (const w of stdout.writes) {
        try {
          emu.feed(w.replace(PROBE_CSI, ''))
        } catch (error) {
          emulatorRefusals.push(String((error as Error).message ?? error))
        }
      }
      return emu.lines().join('\n')
    },
    unmount: () => ink.unmount(),
  }
}
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await settle(50)
  }
  return pred()
}
function draftDots(frame: string): number | null {
  const m = /code: (•*)▌/.exec(frame)
  return m === null ? null : m[1]!.length
}
const CARD_FIELD = 'Paste code here if prompted >'
function fieldAfter(frame: string): string | null {
  const line = frame.split('\n').find(l => l.includes(CARD_FIELD))
  if (line === undefined) return null
  return line.slice(line.indexOf(CARD_FIELD) + CARD_FIELD.length).replace(/[\s│]+$/, '').trim()
}
const ROSTER_LEGEND = '↑↓ move · pgup/pgdn page · ↵ sign in · esc back'
const FACE_HINT = 'c copies the URL'
const FACE_ACK = 'copied to clipboard'
const CARD_HINT = 'press c to copy the URL'
const CARD_ACK = 'Copied to clipboard'
const ESC = '\x1b'
const DOWN = '\x1b[B'
async function typeAbc(m: Mounted): Promise<void> {
  m.push('a')
  await settle(60)
  m.push('b')
  await settle(60)
  m.push('c')
  await settle(400)
}

let copies = 0
const unsubscribe = subscribeClipboardReceipts(() => {
  copies++
})

section('§1 the Boot face’s logins layer — one c, one copy, an empty draft')
{
  const m = mount(
    React.createElement(BootLoginsScreen as never, {
      facts: signedOutFacts(),
      fullScene: { columns: COLS, rows: ROWS },
    }),
  )
  const rosterUp = await waitFor(() => m.screen().includes(ROSTER_LEGEND) && m.screen().includes('Anthropic — Claude subscription'), 4000)
  check('the roster mounted with the OpenAI row leading and the Anthropic row under it', rosterUp && m.screen().indexOf('OpenAI') < m.screen().indexOf('Anthropic — Claude subscription'), m.screen().split('\n').slice(0, 12).map(l => l.trim()).filter(Boolean).join(' | '), 'the roster in src/screen/boot-face/BootLoginsScreen.tsx did not paint its legend and both rows within 4 s, or lists Anthropic above OpenAI')
  m.push(DOWN)
  await settle(200)
  m.push('\r')
  const pickUp = await waitFor(() => ['Claude subscription — browser sign-in', 'Anthropic Console — browser sign-in', 'Anthropic API key — usage-based billing'].every(label => m.screen().includes(label)), 4000)
  check('↵ on the Anthropic row opened the arm pick with all three roads', pickUp, pickUp ? '' : m.screen().split('\n').filter(l => l.includes('│')).slice(4, 12).map(l => l.trim()).join(' | '), 'the Anthropic row in src/screen/boot-face/BootLoginsScreen.tsx must open an arm pick that lists the subscription, Console and API key roads')
  m.push('\r')
  const promptUp = await waitFor(() => m.screen().includes(FACE_HINT), 8000)
  check('↵ on the subscription arm opened the Anthropic flow and the paste prompt came up', promptUp, promptUp ? '' : m.screen().split('\n').filter(l => l.includes('│')).slice(4, 12).map(l => l.trim()).join(' | '), 'the subscription arm in src/screen/boot-face/BootLoginsScreen.tsx must open the Anthropic flow and paint the c copies the URL line')
  check('the draft is empty before any key', draftDots(m.screen()) === 0, String(draftDots(m.screen())), 'the paste draft in the Boot logins flow (src/screen/boot-face/BootLoginsScreen.tsx) must start empty')
  copies = 0
  m.push('c')
  await settle(400)
  check('c copies EXACTLY ONCE (one clipboard receipt)', copies === 1, String(copies), 'the c key in src/screen/boot-face/BootLoginsScreen.tsx must make exactly one copy to the clipboard, not none and not two')
  check('the ack paints', m.screen().includes(FACE_ACK), '', 'paint the copied to clipboard line in src/screen/boot-face/BootLoginsScreen.tsx after the c copy')
  check('THE LAW: the draft stays `code: ▌` — the c never types', draftDots(m.screen()) === 0, String(draftDots(m.screen())), 'the copy handler in src/screen/boot-face/BootLoginsScreen.tsx must consume the c key so the paste draft never receives it')
  await typeAbc(m)
  check('a code containing a c still types: `code: •••▌`, no second copy', draftDots(m.screen()) === 3 && copies === 1, `${draftDots(m.screen())} dots · ${copies} copies`, 'only a bare c with an empty draft may copy; a c typed into a code must reach the draft in src/screen/boot-face/BootLoginsScreen.tsx')
  m.push(ESC)
  await settle(700)
  check('esc returns to the roster (the flow abandoned, nothing stored)', m.screen().includes(ROSTER_LEGEND) && !m.screen().includes(FACE_HINT), '', 'esc in the Anthropic flow of src/screen/boot-face/BootLoginsScreen.tsx must abandon it and repaint the roster')
  m.unmount()
  await settle(100)
}

section('§2 the /logins card — the copy handler consumes the key before the field sees it')
{
  let cancelled = 0
  let done = 0
  const m = mount(
    React.createElement(
      AppStateProvider as never,
      {},
      React.createElement(ConsoleOAuthFlow as never, {
        onDone: () => {
          done++
        },
        onCancel: () => {
          cancelled++
        },
        forceLoginMethod: 'claudeai',
      }),
    ),
  )
  const promptUp = await waitFor(() => m.screen().includes(CARD_HINT), 8000)
  check('the forced claude.ai arm reached the paste prompt', promptUp, promptUp ? '' : m.screen().split('\n').filter(l => l.trim()).slice(0, 8).map(l => l.trim()).join(' | '), 'ConsoleOAuthFlow in src/models/sign-in/flow-cards/SignInFlow.tsx with forceLoginMethod claudeai must paint the press c to copy the URL hint and the paste field')
  check('the field is empty before any key', fieldAfter(m.screen()) === '', JSON.stringify(fieldAfter(m.screen())), 'the paste field in src/models/sign-in/flow-cards/SignInFlow.tsx must start empty')
  copies = 0
  m.push('c')
  await settle(400)
  check('c copies EXACTLY ONCE (one clipboard receipt)', copies === 1, String(copies), 'the c key in src/models/sign-in/flow-cards/SignInFlow.tsx must make exactly one copy to the clipboard, not none and not two')
  check('the ack paints', m.screen().includes(CARD_ACK), '', 'paint the Copied to clipboard line in src/models/sign-in/flow-cards/SignInFlow.tsx after the c copy')
  check('THE LAW: the field stays empty — the c never types', fieldAfter(m.screen()) === '', JSON.stringify(fieldAfter(m.screen())), 'the copy handler in src/models/sign-in/flow-cards/SignInFlow.tsx must consume the c key before the paste field sees it')
  await typeAbc(m)
  check('a code containing a c still types: three characters, no second copy', (fieldAfter(m.screen()) ?? '').length === 3 && copies === 1, `${JSON.stringify(fieldAfter(m.screen()))} · ${copies} copies`, 'only a bare c with an empty field may copy; a c typed into a code must reach the field in src/models/sign-in/flow-cards/SignInFlow.tsx')
  m.push(ESC)
  await settle(700)
  check('esc cancels through the cancel channel, never done', cancelled === 1 && done === 0, `cancelled ${cancelled} · done ${done}`, 'esc in src/models/sign-in/flow-cards/SignInFlow.tsx must call onCancel once and never onDone')
  m.unmount()
  await settle(100)
}

unsubscribe()
check('the emulator understood every paint write (no refused sequence hid a frame)', emulatorRefusals.length === 0, [...new Set(emulatorRefusals)].slice(0, 3).join(' · '), 'the screen wrote a sequence scripts/ink-runtime/ansiEmulator.ts refuses; teach the emulator that sequence or stop the screen writing it')
rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-logins-copy-key-consumed: ALL LAWS HOLD' : `\nprove-logins-copy-key-consumed: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
