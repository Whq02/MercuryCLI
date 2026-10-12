#!/usr/bin/env bun
// gate-watch: src/components/mercury-ui/screens/anthropicLoginModel.ts src/components/ConsoleOAuthFlow.tsx src/components/BootLoginsScreen.tsx src/services/oauth/index.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 700) : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const model = await import('../../src/components/mercury-ui/screens/anthropicLoginModel.ts')
const { createAnthropicLoginMachine, NO_CODE_DELAY_MS, PASTE_PROMPT_DELAY_MS } = model
const words = model as unknown as { BROWSER_OPENED_WORDS?: string; NO_CODE_ARRIVED_WORDS?: string; BROWSER_DID_NOT_OPEN_WORDS?: string; waitingHeadline?: (snap: unknown) => { words: string; warns: boolean } }

type Beat = { fn: () => void; ms: number }
function beatBed(): { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void; run: () => number[]; pending: () => number } {
  const armed: Array<Beat | null> = []
  return {
    setTimer(fn, ms) {
      const handle = { fn, ms }
      armed.push(handle)
      return handle
    },
    clearTimer(handle) {
      const at = armed.indexOf(handle as Beat)
      if (at !== -1) armed[at] = null
    },
    run() {
      const fired: number[] = []
      for (const entry of armed.splice(0, armed.length)) {
        if (entry === null) continue
        fired.push(entry.ms)
        entry.fn()
      }
      return fired
    },
    pending: () => armed.filter(e => e !== null).length,
  }
}

type Service = { urlCb: (url: string, manualUrl?: string) => void; opts: Record<string, unknown>; resolve: (tokens: unknown) => void }
function machineWithFakeService(): { m: ReturnType<typeof createAnthropicLoginMachine>; bed: ReturnType<typeof beatBed>; services: Service[] } {
  const bed = beatBed()
  const services: Service[] = []
  const m = createAnthropicLoginMachine(
    { onDone: () => {} },
    () => {},
    {
      createService: () => {
        const entry: Service = { urlCb: () => {}, opts: {}, resolve: () => {} }
        services.push(entry)
        return {
          startOAuthFlow(urlCallback, options) {
            entry.urlCb = urlCallback
            entry.opts = options as Record<string, unknown>
            return new Promise(resolvePromise => {
              entry.resolve = resolvePromise as (tokens: unknown) => void
            })
          },
          handleManualAuthCodeInput() {},
          cleanup() {},
        }
      },
      saveTokens: () => ({ success: true }),
      usesClaudeAiAuth: () => true,
      mintApiKey: async () => 'key',
      validateOrg: async () => undefined,
      storeAccount: () => {},
      shadowWarning: () => null,
      recordSignIn: () => {},
      settings: () => ({}),
      clipboard: async () => null,
      writeStdout: () => {},
      log: () => {},
      setTimer: bed.setTimer,
      clearTimer: bed.clearTimer,
    },
  )
  return { m, bed, services }
}

section('§1 the machine: the waiting screen stops claiming a browser is open once the road\'s own wait passes with no code')
{
  check('the model exports the wait and the three sentences', typeof NO_CODE_DELAY_MS === 'number' && typeof words.NO_CODE_ARRIVED_WORDS === 'string' && typeof words.BROWSER_DID_NOT_OPEN_WORDS === 'string' && typeof words.waitingHeadline === 'function')
  check('the wait is a real wait, longer than the paste beat and no longer than a minute', NO_CODE_DELAY_MS > PASTE_PROMPT_DELAY_MS && NO_CODE_DELAY_MS <= 60_000, String(NO_CODE_DELAY_MS))
  const { m, bed, services } = machineWithFakeService()
  m.start(true)
  bed.run()
  check('the flow started one service', services.length === 1)
  services[0]!.urlCb('auto-url', 'manual-url')
  const snap0 = m.snapshot() as unknown as { flow: { name: string }; noCodeYet?: boolean; browserOpened?: boolean | null }
  check('the url callback lands waiting with no verdict yet', snap0.flow.name === 'waiting' && snap0.noCodeYet === false && snap0.browserOpened === null, JSON.stringify(snap0))
  const headline0 = words.waitingHeadline?.(snap0)
  check('before the wait the card says a browser window has been opened', headline0?.words === words.BROWSER_OPENED_WORDS && headline0?.warns === false, JSON.stringify(headline0))
  check('the service was handed the opener\'s verdict channel', typeof services[0]!.opts['onBrowserOpen'] === 'function')
  const fired = bed.run()
  check('the paste beat and the no-code beat are both armed on entering waiting', fired.includes(PASTE_PROMPT_DELAY_MS) && fired.includes(NO_CODE_DELAY_MS), JSON.stringify(fired))
  const snap1 = m.snapshot() as unknown as { noCodeYet?: boolean; pastePromptUp: boolean }
  check('after the wait with no code: noCodeYet is true and the paste road is up', snap1.noCodeYet === true && snap1.pastePromptUp === true, JSON.stringify(snap1))
  const headline1 = words.waitingHeadline?.(snap1)
  check('…and the card says no code arrived from the browser, naming the copy-the-URL road, as a warning', headline1?.words === words.NO_CODE_ARRIVED_WORDS && headline1?.warns === true && /No code arrived from the browser/.test(headline1?.words ?? '') && /press c to copy/.test(headline1?.words ?? ''), JSON.stringify(headline1))
  check('…and never still says a browser window has been opened', !(headline1?.words ?? '').includes('A browser window has been opened'))
  ;(services[0]!.opts['onBrowserOpen'] as (opened: boolean) => void)(false)
  const snap2 = m.snapshot() as unknown as { browserOpened?: boolean | null }
  const headline2 = words.waitingHeadline?.(snap2)
  check('the opener\'s own "no" wins: the card says the browser did not open and offers the URL', snap2.browserOpened === false && headline2?.words === words.BROWSER_DID_NOT_OPEN_WORDS && headline2?.warns === true, JSON.stringify(headline2))
  m.reset()
  const snap3 = m.snapshot() as unknown as { noCodeYet?: boolean; browserOpened?: boolean | null; flow: { name: string } }
  check('reset clears the verdicts with the flow', snap3.flow.name === 'idle' && snap3.noCodeYet === false && snap3.browserOpened === null, JSON.stringify(snap3))
}

section('§2 the machine: a code that arrives before the wait leaves the wait silent')
{
  const { m, bed, services } = machineWithFakeService()
  m.start(true)
  bed.run()
  services[0]!.urlCb('auto-url', 'manual-url')
  services[0]!.resolve({ accessToken: 'at', scopes: ['claude'], tokenAccount: { uuid: 'u', emailAddress: 'op@example.test' } })
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  const fired = bed.run()
  const snap = m.snapshot() as unknown as { flow: { name: string }; noCodeYet?: boolean }
  check('the sign-in settled before the beats fired', snap.flow.name === 'success', JSON.stringify(snap.flow))
  check('the no-code beat fired but claimed nothing (the flow had left waiting)', fired.includes(NO_CODE_DELAY_MS) && snap.noCodeYet === false, JSON.stringify({ fired, noCodeYet: snap.noCodeYet }))
}

section('§3 the Boot face\'s sign-in pane speaks the same words with the URL road beside them')
{
  const { anthropicFlowPaneLines } = await import('../../src/components/BootLoginsScreen.tsx')
  const base = { flow: { name: 'waiting', url: 'https://sign-in.example/' + 'a'.repeat(40), loginWithClaudeAi: true, forcedMethod: null }, pastePromptUp: true, copied: false, shadowWarning: null, accountLabel: null }
  const before = anthropicFlowPaneLines({ ...base, noCodeYet: false, browserOpened: null } as never, 0)
  check('before the wait the pane says a browser window has been opened', before.join('\n').includes('A browser window has been opened'), before.join(' | '))
  const after = anthropicFlowPaneLines({ ...base, noCodeYet: true, browserOpened: null } as never, 0)
  check('after the wait the pane leads with no code arrived from the browser', /No code arrived from the browser/.test(after[0] ?? '') && !after.join('\n').includes('A browser window has been opened'), after.join(' | '))
  check('…keeps the URL road in the same pane (the URL whole, c copies it, the paste line, the way out)', after.join('').includes('a'.repeat(40)) && after.includes('c copies the URL') && after.includes('Paste code here if prompted:') && after[after.length - 1] === 'esc cancels the wait', after.join(' | '))
  check('…and every line fits the pane', after.every(l => l.length <= 38), after.filter(l => l.length > 38).join(' | '))
  const failed = anthropicFlowPaneLines({ ...base, noCodeYet: false, browserOpened: false } as never, 0)
  check('an opener that said no reads "the browser did not open" at once', /The browser did not open/.test(failed[0] ?? ''), failed.join(' | '))
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty' || !existsSync(DIST)) {
  console.log(`prove-sign-in-no-code-wait: the in-chat card leg SKIPPED — ${driver.kind !== 'posix-pty' ? `no POSIX pty capture driver (${driver.kind})` : 'dist/mercury.mjs is not built'}`)
} else {
  section('§4 the in-chat /logins card on the fixture road (BROWSER=/usr/bin/true, no window ever opens): the words change at the wait')
  const scratch = mkdtempSync(join(tmpdir(), 'sign-in-no-code-'))
  try {
    const CWD = join(scratch, 'cwd')
    mkdirSync(CWD, { recursive: true })
    writeFileSync(join(CWD, 'README.md'), '# a small folder\n')
    const HOME = join(scratch, 'home')
    seedFirstRun(HOME, [CWD])
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_CONFIG_DIR: HOME,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_UPDATE_NOTICE: '0',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      BROWSER: '/usr/bin/true',
    }
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_MODEL', 'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI']) delete env[key]
    const waitTicks = Math.ceil(NO_CODE_DELAY_MS / 200) + 25
    const sends: unknown[] = [
      { data: '', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
      { data: '\r', afterPrevTicks: 2 },
      { data: '', atTick: 999, awaitText: '↵ sends', requireAwait: true, awaitSettleTicks: 10 },
      { data: '/logins\r', afterPrevTicks: 5 },
      { data: '', atTick: 999, awaitText: 'Claude subscription account', requireAwait: true, awaitSettleTicks: 6, mark: 'menu' },
      { data: '\u001b[B', afterPrevTicks: 3 },
      { data: '\r', afterPrevTicks: 3 },
      { data: '', atTick: 999, awaitText: 'press c to copy the URL', requireAwait: true, awaitSettleTicks: 4, mark: 'opened' },
      { data: '', atTick: 999, awaitText: 'No code arrived from the browser', requireAwait: true, minTick: 1, awaitSettleTicks: 4, mark: 'no-code' },
    ]
    const grid = join(scratch, 'grid.json')
    const cfgPath = join(scratch, 'vshot.json')
    const total = 200 + waitTicks + 100
    writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST, '--chat'], sends, total, cols: 120, rows: 40, out: grid, title: 'sign-in wait' }))
    const r = spawnSync(driver.python, [VSHOT, cfgPath], { env, cwd: CWD, encoding: 'utf8', timeout: vshotBudgetMs(total * 200 * 2.5 + 60_000) })
    type Grid = Array<Array<{ c?: string } | string>>
    const gridText = (g: Grid): string => g.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
    const marks: Record<string, string> = {}
    let endReason = ''
    let undelivered = 0
    if (existsSync(grid)) {
      const payload = JSON.parse(readFileSync(grid, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }>; endReason?: string; undeliveredSends?: unknown[] }
      for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
      endReason = payload.endReason ?? ''
      undelivered = Array.isArray(payload.undeliveredSends) ? payload.undeliveredSends.length : 0
    }
    if (frameDir) for (const [label, text] of Object.entries(marks)) writeFileSync(join(frameDir, `card-${label}.txt`), `${text}\n`)
    const menu = marks.menu ?? ''
    const opened = marks.opened ?? ''
    const noCode = marks['no-code'] ?? ''
    check('the /logins card opened on its family menu', menu.includes('Claude subscription account'), `${endReason} · vshot ${String(r.status)} · ${(r.stderr ?? '').slice(-300)}`)
    check('the Claude row opened the browser road: the card says a browser window has been opened and offers the URL and c', opened.includes('A browser window has been opened') && opened.includes('press c to copy the URL') && opened.includes('Paste code here if prompted'), opened.split('\n').filter(l => /browser|copy|Paste/.test(l)).join(' | '))
    check('after the wait with no code the card says so: "No code arrived from the browser yet"', noCode.includes('No code arrived from the browser yet'), `${endReason} · undelivered ${undelivered} · ` + noCode.split('\n').filter(l => /browser|code/i.test(l)).join(' | '))
    check('…it no longer says a browser window has been opened', noCode !== '' && !noCode.includes('A browser window has been opened'), noCode.split('\n').filter(l => /browser/.test(l)).join(' | '))
    check('…and the copy-the-URL road stands in the same card', noCode.includes('press c to copy') && noCode.includes('Paste code here if prompted'), noCode.split('\n').filter(l => /copy|Paste/.test(l)).join(' | '))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-sign-in-no-code-wait — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-sign-in-no-code-wait — all checks pass')
process.exit(0)
