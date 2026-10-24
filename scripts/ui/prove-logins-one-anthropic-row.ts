#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = mkdtempSync(join(tmpdir(), 'mercury-logins-one-anthropic-row-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.FORCE_COLOR = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true'
process.env.SSH_CONNECTION = 'proof'
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|XAI_|META_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|KIMI_|DEEPSEEK_|HF_|HUGGINGFACE_|MISTRAL_|NOUS_|MINIMAX_|TOGETHER_|COHERE_|GROQ_|CEREBRAS_|FIREWORKS_|QWEN_|DASHSCOPE_)/.test(name)) delete process.env[name]
}
for (const key of ['TMUX', 'LC_TERMINAL', 'SSH_CLIENT', 'SSH_TTY']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const React = await import('react')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const starts: boolean[] = []
let resets = 0
async function stub(path: string, overrides: Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...overrides }))
}
await stub('../../src/context/notifications.js', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
await stub('../../src/hooks/useCatalogueEpoch.js', { useCatalogueEpoch: () => 0 })
await stub('../../src/utils/model/computedDefault.js', { mostRecentSignInFamily: () => undefined })
await stub('../../src/components/mercury-ui/screens/anthropicLoginModel.js', {
  useAnthropicLoginModel: () => ({
    flow: { name: 'idle' },
    pastePromptUp: false,
    noCodeYet: false,
    browserOpened: null,
    copied: false,
    shadowWarning: null,
    accountLabel: null,
    start: (loginWithClaudeAi: boolean) => {
      starts.push(loginWithClaudeAi)
    },
    reset: () => {
      resets++
    },
    submitCode: () => false,
    retry() {},
    copyUrl() {},
  }),
})

const { default: Ink } = await import('../../src/ink/ink.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')
const owner = (await import('../../src/components/loginFamilyRows.js')) as Record<string, unknown>
const login = await import('../../src/commands/login/login.tsx')
const screen = await import('../../src/components/BootLoginsScreen.js')
const { ConsoleOAuthFlow } = await import('../../src/components/ConsoleOAuthFlow.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { signedOutFacts } = await import('./face-logins-stills.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const OLD_SUBSCRIPTION_ROW = 'Claude subscription account'
const OLD_USAGE_ROW = 'Usage-based billing — Anthropic Console sign-in or API key'
const ANTHROPIC_ROW = 'Anthropic — Claude subscription or Console sign-in / API key'
const SUBSCRIPTION_ARM = 'Claude subscription — browser sign-in'
const USAGE_ARM = 'Usage-based billing — Anthropic Console sign-in or API key'
const CARD_PICK_TITLE = 'Usage-based billing — Anthropic Console'
const ROSTER_LEGEND = '↑↓ move · pgup/pgdn page · ↵ sign in · esc back'
const PICK_LEGEND = '↑↓ move · ↵ pick · esc back'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const ENTER = '\r'

type Row = { label: string; value: string }
const loginFamilyRows = owner['loginFamilyRows'] as (o: { engineLegs: boolean }) => Row[]
const armPick = ((owner['anthropicArmPickRows'] as ReadonlyArray<Row> | undefined) ?? []) as ReadonlyArray<Row>
const loginFamilyFocusFor = owner['loginFamilyFocusFor'] as (f: string | undefined) => string | undefined

section('§1 the catalogue: one Anthropic row, second after OpenAI, carrying both roads as an arm pick')
{
  const rows = loginFamilyRows({ engineLegs: true })
  const anthropicRows = rows.filter(row => row.label.startsWith('Anthropic'))
  check('exactly one row whose label begins Anthropic', anthropicRows.length === 1, rows.map(row => row.label).join(' | '))
  check('OpenAI still leads the list', rows[0]?.value === 'openai', rows[0]?.label ?? 'no first row')
  check('the Anthropic row is second, right after OpenAI', rows[1]?.label === ANTHROPIC_ROW && rows[1]?.value === 'anthropic', rows[1]?.label ?? 'no second row')
  check('no row is labelled Claude subscription account', !rows.some(row => row.label === OLD_SUBSCRIPTION_ROW))
  check('no row is labelled Usage-based billing', !rows.some(row => row.label.startsWith('Usage-based billing')))
  check('no row keeps the retired values claudeai or console', !rows.some(row => row.value === 'claudeai' || row.value === 'console'))
  check('twenty rows: the two Anthropic rows became one, every other family kept its row', rows.length === 20, String(rows.length))
  const restricted = loginFamilyRows({ engineLegs: false })
  check('a host without engine legs offers the one Anthropic row alone', restricted.length === 1 && restricted[0]?.label === ANTHROPIC_ROW, restricted.map(row => row.label).join(' | '))
  check('the arm pick offers both roads in order: the subscription arm, then the usage-based arm', armPick.map(arm => arm.value).join(',') === 'claudeai,console', armPick.map(arm => arm.value).join(','))
  check('the subscription arm names the Claude subscription and its browser sign-in', armPick[0]?.label === SUBSCRIPTION_ARM, armPick[0]?.label ?? 'absent')
  check('the usage-based arm keeps the Console words the roster carried before', armPick[1]?.label === USAGE_ARM, armPick[1]?.label ?? 'absent')
  check('the recorded default anthropic pre-focuses the one Anthropic row', loginFamilyFocusFor('anthropic') === 'anthropic', String(loginFamilyFocusFor('anthropic')))
  check('/logins anthropic, claude, claudeai and console all pre-focus the one Anthropic row', ['anthropic', 'claude', 'claudeai', 'console'].every(word => login.parseFamilyFocus(word) === 'anthropic'), ['anthropic', 'claude', 'claudeai', 'console'].map(word => `${word}→${String(login.parseFamilyFocus(word))}`).join(' '))
  const arms = screen.loginsCatalogue()
  check('the face catalogue binds exactly one row to the anthropic family', arms.filter(arm => arm.familyId === 'anthropic').length === 1, arms.filter(arm => arm.familyId === 'anthropic').map(arm => arm.row.label).join(' | '))
  check('the distinct family count stays twenty', screen.loginsFamilyCounts([]).familyIds.length === 20, String(screen.loginsFamilyCounts([]).familyIds.length))
  check('the face pick for the Anthropic row is the row owner\'s pair, byte-same', JSON.stringify(screen.loginsPickOptions('anthropic' as never).map(option => option.label)) === JSON.stringify(armPick.map(arm => arm.label)) && armPick.length === 2)
  const pane = screen.loginsPickPaneLines('anthropic' as never)
  check('the face pick pane explains the two credentials and names the way out', pane.join(' ').includes('One Anthropic family, two credentials') && pane[pane.length - 1] === 'esc — back to the roster', pane.join(' | '))
}

const COLS = 120
const ROWS = 60
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
  pause(): this {
    return this
  }
  resume(): this {
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
function mount(element: React.ReactElement): Mounted {
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new FakeStdout() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(element)
  return {
    push: data => stdin.push(data),
    screen: () => {
      const emu = new AnsiEmulator(COLS, ROWS, false)
      for (const w of stdout.writes) {
        try {
          emu.feed(w.replace(PROBE_CSI, ''))
        } catch {
          void 0
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
async function key(m: Mounted, data: string): Promise<void> {
  m.push(data)
  await settle(120)
}
const linesWith = (frame: string, needle: string): string[] => frame.split('\n').filter(line => line.includes(needle))
const rowOrder = (frame: string, first: string, second: string): boolean => {
  const lines = frame.split('\n')
  const a = lines.findIndex(line => line.includes(first))
  const b = lines.findIndex(line => line.includes(second))
  return a >= 0 && b >= 0 && a < b
}
const rosterTruth = (tag: string, frame: string, anthropicNeedle: string): void => {
  check(`${tag}: exactly one row begins Anthropic`, linesWith(frame, anthropicNeedle).length === 1, linesWith(frame, 'Anthropic').join(' | ') || 'no Anthropic row painted')
  check(`${tag}: OpenAI is still the first row`, rowOrder(frame, 'OpenAI — ChatGPT subscription', anthropicNeedle))
  check(`${tag}: no row says Claude subscription account`, !frame.includes(OLD_SUBSCRIPTION_ROW))
  check(`${tag}: no row says Usage-based billing`, !frame.includes('Usage-based billing —'))
}

section('§2 the /logins card: the one row, then the arm pick, each arm its own road')
{
  const m = mount(
    React.createElement(
      AppStateProvider as never,
      {},
      React.createElement(
        ThemeProvider as never,
        {},
        React.createElement(KeybindingSetup, {}, React.createElement(ConsoleOAuthFlow as never, { onDone() {}, onCancel() {}, onOpenaiDone() {} })),
      ),
    ),
  )
  const up = await waitFor(() => m.screen().includes('OpenAI — ChatGPT subscription') && m.screen().includes('Anthropic'), 6000)
  check('the card opened on its family menu', up, m.screen().split('\n').filter(l => l.trim()).slice(0, 6).join(' | '))
  rosterTruth('card', m.screen(), ANTHROPIC_ROW)
  await key(m, DOWN)
  await key(m, ENTER)
  const pickUp = await waitFor(() => m.screen().includes(CARD_PICK_TITLE), 3000)
  check('↵ on the Anthropic row opens the arm pick (the Claude subscription and Anthropic Console rows)', pickUp, m.screen().split('\n').filter(l => l.trim()).slice(0, 6).join(' | '))
  check('the pick offers the subscription arm', m.screen().includes(SUBSCRIPTION_ARM))
  check('the pick offers the usage-based arm', m.screen().includes(USAGE_ARM))
  check('the pick started nothing by itself', starts.length === 0, JSON.stringify(starts))
  await key(m, ESC)
  const back = await waitFor(() => m.screen().includes(ANTHROPIC_ROW) && !m.screen().includes(CARD_PICK_TITLE), 3000)
  check('esc on the pick returns to the family menu with nothing started', back && starts.length === 0, JSON.stringify(starts))
  await key(m, DOWN)
  await key(m, ENTER)
  await waitFor(() => m.screen().includes(CARD_PICK_TITLE), 3000)
  await key(m, ENTER)
  await waitFor(() => starts.length === 1, 3000)
  check('the subscription arm runs the claude.ai road (start(true))', JSON.stringify(starts) === JSON.stringify([true]), JSON.stringify(starts))
  await waitFor(() => m.screen().includes(ANTHROPIC_ROW) && !m.screen().includes(CARD_PICK_TITLE), 3000)
  await key(m, DOWN)
  await key(m, ENTER)
  await waitFor(() => m.screen().includes(CARD_PICK_TITLE), 3000)
  await key(m, DOWN)
  await key(m, ENTER)
  await waitFor(() => starts.length === 2, 3000)
  check('the usage-based arm runs the Console road (start(false))', JSON.stringify(starts) === JSON.stringify([true, false]), JSON.stringify(starts))
  m.unmount()
  await settle(100)
}

section('§3 the boot Logins screen: the one row, then the same arm pick, each arm its own road')
{
  starts.length = 0
  resets = 0
  const m = mount(React.createElement(screen.BootLoginsScreen as never, { facts: signedOutFacts(), fullScene: { columns: COLS, rows: ROWS } }))
  const up = await waitFor(() => m.screen().includes(ROSTER_LEGEND) && m.screen().includes('Anthropic'), 6000)
  check('the roster mounted', up, m.screen().split('\n').filter(l => l.includes('│')).slice(4, 12).map(l => l.trim()).join(' | '))
  rosterTruth('face', m.screen(), 'Anthropic — Claude subscription')
  await key(m, DOWN)
  await key(m, ENTER)
  const pickUp = await waitFor(() => m.screen().includes(PICK_LEGEND) && m.screen().includes('Claude subscription — browser sign-in'), 3000)
  check('↵ on the Anthropic row opens the arm pick', pickUp, m.screen().split('\n').filter(l => l.includes('│')).slice(4, 14).map(l => l.trim()).join(' | '))
  check('the pick offers the usage-based arm', m.screen().includes('Usage-based billing — Anthropic Console'))
  check('the pick explains the two credentials beside the rows', m.screen().includes('One Anthropic family, two credentials'))
  check('the pick started nothing by itself', starts.length === 0, JSON.stringify(starts))
  await key(m, ESC)
  const back = await waitFor(() => m.screen().includes(ROSTER_LEGEND) && !m.screen().includes(PICK_LEGEND), 3000)
  check('esc on the pick returns to the roster with nothing started', back && starts.length === 0, JSON.stringify(starts))
  await key(m, ENTER)
  await waitFor(() => m.screen().includes(PICK_LEGEND), 3000)
  await key(m, ENTER)
  await waitFor(() => starts.length === 1, 3000)
  check('the subscription arm resets the machine and runs the claude.ai road (start(true))', JSON.stringify(starts) === JSON.stringify([true]) && resets === 1, `${JSON.stringify(starts)} resets=${resets}`)
  await key(m, ESC)
  await waitFor(() => m.screen().includes(ROSTER_LEGEND), 3000)
  await key(m, ENTER)
  await waitFor(() => m.screen().includes(PICK_LEGEND), 3000)
  await key(m, DOWN)
  await key(m, ENTER)
  await waitFor(() => starts.length === 2, 3000)
  check('the usage-based arm runs the Console road (start(false))', JSON.stringify(starts) === JSON.stringify([true, false]), JSON.stringify(starts))
  m.unmount()
  await settle(100)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-logins-one-anthropic-row: ALL LAWS HOLD' : `\nprove-logins-one-anthropic-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
