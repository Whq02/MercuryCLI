#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { keyHintLabel } from '../../src/components/mercury-ui/keyHintLabel.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const CODE = 'ABCD-1234'
const URL = 'https://github.com/login/device'
const WAIT_S = 22

section("the ! shell row on the built product: a command that prints a code and a URL, then waits — the owner's gh auth shape")
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  check('the pty capture driver is available', false, driver.kind)
} else if (!existsSync(DIST)) {
  check('dist/mercury.mjs is built', false, DIST)
} else {
  const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
  const nodeBin = existsSync(vendoredNode) ? vendoredNode : (Bun.which('node') ?? 'node')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bang-shell-row-')))
  const shimDir = join(scratch, 'bin')
  mkdirSync(shimDir, { recursive: true })
  for (const exe of ['git', 'ssh']) {
    const shim = join(shimDir, exe)
    writeFileSync(shim, '#!/bin/sh\nexit 128\n')
    chmodSync(shim, 0o755)
  }
  const opened = join(scratch, 'opened.txt')
  const browser = join(scratch, 'browser.sh')
  writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(opened)}\n`)
  chmodSync(browser, 0o755)
  const project = join(scratch, 'proj')
  mkdirSync(project, { recursive: true })
  const firstBytes = join(project, 'first-bytes.txt')
  writeFileSync(join(project, 'README.md'), '# fixture project\n')
  const home = join(scratch, 'home-cfg')
  seedFirstRun(home, [project])
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
    HOME: join(scratch, 'home'),
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    USER: 'sam',
    TERM: 'xterm-256color',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_UPDATE_NOTICE: '0',
    BROWSER: browser,
  }
  for (const key of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY',
    'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI', 'VSHOT_ACTIVE', 'MERCURY_CRITTER',
  ]) {
    delete env[key]
  }
  mkdirSync(env.HOME!, { recursive: true })

  type Cell = { c: string }
  type Mark = { label: string; grid: Cell[][]; atMs: number; atTick: number }
  type Receipt = { atTick: number; ts: number }
  const CHAT = 'shift + ← boot face'
  void keyHintLabel
  const command = `sh -c 'c=ABCD; u=https://github.com/login; echo "! First copy your one-time code: $c-1234" >&2; echo "Open $u/device in your browser" >&2; perl -MTime::HiRes=time -e "print time" > first-bytes.txt; sleep ${WAIT_S}'`
  const on = (needle: string, data: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    atTick: 299,
    awaitText: needle,
    minTick: 1,
    requireAwait: true,
    data,
    ...extra,
  })
  const sends: Record<string, unknown>[] = [
    { atTick: 80, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    { atTick: 160, awaitText: 'Type a prompt', minTick: 5, awaitStableTicks: 2, requireAwait: true, data: '' },
    on(CHAT, '!' + command),
    on(`! sh -c 'c=ABCD`, '\r', { mark: 'submitted' }),
    on(CODE, '', { mark: 'painted' }),
    on('login/device', `\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m`, { targetText: 'login/device', targetDx: 2, awaitSettleTicks: 2, mark: 'clicked' }),
    on('running · ', '', { awaitPattern: 'running · (1[2-9]|[2-9][0-9])s', mark: 'waiting' }),
    on('exit 0', '', { awaitSettleTicks: 3, mark: 'exited' }),
  ]
  const gridPath = join(scratch, 'capture.json')
  const cfgPath = join(scratch, 'capture-cfg.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: [nodeBin, DIST, '--chat'], cwd: project, sends, total: 300, readyText: [CHAT], stableTicks: 4, cols: 120, rows: 40, out: gridPath, title: 'bang-shell-row' }))
  const res = spawnSync(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { env, cwd: project, encoding: 'utf8', timeout: vshotBudgetMs(180_000) })
  if (res.status !== 0 || !existsSync(gridPath)) {
    check('the capture ran', false, (res.stderr ?? '').slice(-600))
  } else {
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { marks?: Mark[]; sendReceipts?: Receipt[] }
    const marks = new Map((payload.marks ?? []).map(m => [m.label, m]))
    const rows = (grid: Cell[][]): string[] => grid.map(row => row.map(c => c.c || ' ').join(''))
    const rowBlock = (grid: Cell[][]): string[] => {
      const all = rows(grid)
      const at = all.findIndex(r => r.includes("[sam] !sh -c 'c=ABCD"))
      if (at < 0) return []
      const left = Math.max(0, all[at]!.indexOf('[sam]') - 9)
      return all.slice(at, at + 12).map(r => r.slice(left).replace(/│\s*$/, '').trimEnd())
    }
    const submitted = marks.get('submitted')
    const painted = marks.get('painted')
    const clicked = marks.get('clicked')
    const waiting = marks.get('waiting')
    const exited = marks.get('exited')
    for (const [label, mark] of marks) writeFileSync(join(scratch, `frame-${label}.txt`), rows(mark.grid).map(r => r.trimEnd()).join('\n') + '\n')
    check('the command was submitted and its row painted the code and the URL', submitted !== undefined && painted !== undefined, [...marks.keys()].join(', '))
    if (submitted !== undefined && painted !== undefined) {
      const live = rowBlock(painted.grid)
      check('the live tail shows the code line and the URL line under the command, in the chat', live.some(r => r.includes(CODE)) && live.some(r => r.includes(URL)), live.join(' | '))
      const sinceSubmit = painted.atMs - submitted.atMs
      const receipt = (payload.sendReceipts ?? []).find(r => r.atTick === submitted.atTick)
      const firstBytesAt = existsSync(firstBytes) ? Number(readFileSync(firstBytes, 'utf8').trim()) * 1000 : NaN
      const t0 = receipt === undefined ? NaN : receipt.ts - submitted.atMs
      const sinceFirstBytes = Number.isFinite(firstBytesAt) && Number.isFinite(t0) ? t0 + painted.atMs - firstBytesAt : NaN
      console.log(`      painted ${sinceSubmit} ms after the submit; ${Number.isFinite(sinceFirstBytes) ? `${Math.round(sinceFirstBytes)} ms after the command wrote its first bytes` : 'first-bytes stamp unavailable'}`)
      check('the tail painted within a second of the first bytes (the 200 ms poll)', Number.isFinite(sinceFirstBytes) ? sinceFirstBytes <= 1_000 : sinceSubmit <= 1_500, `${sinceSubmit} ms after submit, ${Math.round(sinceFirstBytes)} ms after the first bytes`)
    }
    check('the tail stays while the command waits, with its clock ticking', waiting !== undefined && rowBlock(waiting.grid).some(r => r.includes(CODE)) && rowBlock(waiting.grid).some(r => r.includes(URL)) && rowBlock(waiting.grid).some(r => /running · (1[2-9]|[2-9][0-9])s/.test(r)), waiting ? rowBlock(waiting.grid).join(' | ') : 'no waiting frame')
    const openedUrls = existsSync(opened) ? readFileSync(opened, 'utf8').split('\n').filter(Boolean) : []
    check('a click on the URL in the live tail opens it the way the chat opens its links (the browser handler received the URL once)', clicked !== undefined && openedUrls.length === 1 && openedUrls[0] === URL, JSON.stringify({ clicked: clicked !== undefined, openedUrls }))
    check('the row keeps its output after exit: the exited form shows the code line, the URL line and the exit words', exited !== undefined && rowBlock(exited.grid).some(r => r.includes(CODE)) && rowBlock(exited.grid).some(r => r.includes(URL)) && rowBlock(exited.grid).some(r => /exit 0/.test(r)) && !rowBlock(exited.grid).some(r => /running ·/.test(r)), exited ? rowBlock(exited.grid).join(' | ') : 'no exited frame')
    console.log(`      frames saved under ${scratch} (frame-<mark>.txt)`)
  }
}

console.log(failures === 0 ? '\nBANG SHELL ROW LIVE: ALL LAWS HOLD' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
