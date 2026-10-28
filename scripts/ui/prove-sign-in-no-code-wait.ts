#!/usr/bin/env bun
// gate-watch: src/components/mercury-ui/screens/anthropicLoginModel.ts src/components/ConsoleOAuthFlow.tsx src/components/BootLoginsScreen.tsx src/services/oauth/index.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, firstOutputTs, firstPtyVisibility, grabScreens, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

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

if (!existsSync(DIST)) {
  console.log('prove-sign-in-no-code-wait: the in-chat card leg SKIPPED — dist/mercury.mjs is not built')
} else {
  section('§4 the in-chat /logins card on the fixture road (BROWSER=/usr/bin/true, no window ever opens): the words change at the wait')
  const COLS = 120
  const ROWS = 40
  const COMPOSER_READY = 'Type a prompt'
  const MENU_ROW = 'Anthropic — Claude subscription'
  const MENU_PAINTED = 'Anthropic'
  const PICK_PAINTED = 'Anthropic Console'
  const OPENED = 'press c to copy the URL'
  const NO_CODE = 'No code arrived from the browser'
  const squash = (s: string): string => s.replace(/\s+/g, '')
  const painted = (run: ArenaRun, text: string, notBefore = 0): { ts: number; text: string } | undefined => firstPtyVisibility(run.ptyReads, squash(text), notBefore)
  const steady = (row: string): string => row.replace(/flux-arena-cwd-[A-Za-z0-9]+/g, 'the-project').replace(/\b\d\d:\d\d:\d\d\b/g, 'hh:mm:ss').replace(/\s+$/, '')
  const screenAfter = (run: ArenaRun, paint: { ts: number } | undefined, settleMs = 700): string[] | null => {
    if (paint === undefined) return null
    const [frame] = grabScreens(run, COLS, ROWS, [Math.max(0, paint.ts - firstOutputTs(run) + settleMs)])
    return frame ? frame.rows : null
  }
  const run = await runArtifactArena({
    turns: [],
    sends: [`after:${COMPOSER_READY}:1500:/logins`, `after:${COMPOSER_READY}:2300:\\r`, `after:${MENU_PAINTED}:900:\\x1b[B`, `after:${MENU_PAINTED}:1500:\\r`, `after:${PICK_PAINTED}:900:\\r`],
    seconds: Math.ceil(NO_CODE_DELAY_MS / 1000) + 45,
    cols: COLS,
    rows: ROWS,
    keep: true,
    anchor: null,
    seedCwd: { 'README.md': '# a small folder\n' },
    extraEnv: { BROWSER: '/usr/bin/true', MERCURY_UPDATE_NOTICE: '0', ANTHROPIC_API_KEY: '' },
  })
  try {
    const unfired = `${run.outcome.reason ?? 'complete'} · unfired ${JSON.stringify(run.outcome.report?.unfired ?? [])}`
    const chatPaint = painted(run, COMPOSER_READY)
    const menuPaint = painted(run, MENU_ROW, chatPaint?.ts ?? 0)
    const pickPaint = painted(run, PICK_PAINTED, menuPaint?.ts ?? 0)
    const waitingPaint = painted(run, 'A browser window has been opened', pickPaint?.ts ?? 0)
    const openedPaint = painted(run, OPENED, pickPaint?.ts ?? 0)
    const noCodePaint = painted(run, NO_CODE, openedPaint?.ts ?? 0)
    const menu = screenAfter(run, menuPaint)
    const pick = screenAfter(run, pickPaint)
    const opened = screenAfter(run, openedPaint)
    const noCode = screenAfter(run, noCodePaint)
    if (frameDir) for (const [label, rows] of [['menu', menu], ['pick', pick], ['opened', opened], ['no-code', noCode]] as const) if (rows) writeFileSync(join(frameDir, `card-${label}.txt`), rows.map(steady).join('\n') + '\n')
    const rowsWith = (rows: string[] | null, re: RegExp): string => (rows ?? []).filter(l => re.test(l)).join(' | ')
    check('the /logins card opened on its family menu', menu !== null && menu.some(l => l.includes(MENU_ROW)), unfired)
    check('the Anthropic row opened the arm pick offering its three roads', pick !== null && pick.some(l => l.includes('Claude subscription — browser sign-in')) && pick.some(l => l.includes('Anthropic Console — browser sign-in')) && pick.some(l => l.includes('Anthropic API key — usage-based billing')), pick === null ? unfired : rowsWith(pick, /subscription|Anthropic Console|API key/))
    check('the subscription arm opened the browser road: the card says a browser window has been opened and offers the URL and c', opened !== null && opened.some(l => l.includes('A browser window has been opened')) && opened.some(l => l.includes(OPENED)) && opened.some(l => l.includes('Paste code here if prompted')), opened === null ? unfired : rowsWith(opened, /browser|copy|Paste/))
    check('after the wait with no code the card says so: "No code arrived from the browser yet"', noCode !== null && noCode.some(l => l.includes('No code arrived from the browser yet')), noCode === null ? `the words never painted · ${unfired}` : rowsWith(noCode, /browser|code/i))
    check('…it no longer says a browser window has been opened', noCode !== null && !noCode.some(l => l.includes('A browser window has been opened')), rowsWith(noCode, /browser/))
    check('…and the copy-the-URL road stands in the same card', noCode !== null && noCode.some(l => l.includes('press c to copy')) && noCode.some(l => l.includes('Paste code here if prompted')), rowsWith(noCode, /copy|Paste/))
    check('the no-code words came after the wait, not before it', waitingPaint !== undefined && noCodePaint !== undefined && noCodePaint.ts - waitingPaint.ts >= NO_CODE_DELAY_MS - 3000, `${waitingPaint && noCodePaint ? noCodePaint.ts - waitingPaint.ts : 'n/a'} ms between the waiting screen and the no-code words`)
  } finally {
    run.cleanup()
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-sign-in-no-code-wait — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-sign-in-no-code-wait — all checks pass')
process.exit(0)
