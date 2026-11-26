#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { recordPty, type PtyRecord } from '../lib/ptyRecorder.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const distArgIdx = process.argv.indexOf('--dist')
const BIN = distArgIdx >= 0 && process.argv[distArgIdx + 1] ? process.argv[distArgIdx + 1]! : join(REPO, 'dist', 'mercury.mjs')
const NODE = existsSync(join(dirname(BIN), 'vendor/node/bin/node')) ? join(dirname(BIN), 'vendor/node/bin/node') : 'node'

if (!existsSync(BIN)) {
  console.error(`prove-devin-cli-pty-drive: missing bundle at ${BIN} — run bun run build.ts first`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('[SKIP] POSIX PTY handoff proof requires POSIX PTY')
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-devin-pty-')))
const configHome = join(scratch, 'config')
const homeDir = join(scratch, 'home')
const xdgData = join(scratch, 'xdg-data')
const xdgConfig = join(scratch, 'xdg-config')
const cwdDir = join(scratch, 'project')
const fakeBin = join(scratch, 'fake-bin')
const logFile = join(scratch, 'pty-invocations.jsonl')
const statusModeFile = join(scratch, 'status-mode.txt')
const recBoot = join(scratch, 'boot.pty')
const recChat = join(scratch, 'chat.pty')

mkdirSync(configHome, { recursive: true })
mkdirSync(homeDir, { recursive: true })
mkdirSync(join(xdgData, 'devin'), { recursive: true })
mkdirSync(xdgConfig, { recursive: true })
mkdirSync(cwdDir, { recursive: true })
mkdirSync(fakeBin, { recursive: true })
seedFirstRun(configHome, [cwdDir])
writeFileSync(statusModeFile, 'ok', 'utf8')

const STATUS_SECRET_MARKER = 'ordinary-fixture-marker'
const AMBIENT_WINDSURF_MARKER = 'synthetic-ambient-windsurf-marker'
const stubPath = join(fakeBin, 'devin')
const stubScript = `#!${NODE}
const fs = require('node:fs')
const args = process.argv.slice(2)
const logPath = ${JSON.stringify(logFile)}
const modePath = ${JSON.stringify(statusModeFile)}
const record = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n', 'utf8')
const tty = { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) }
if (args[0] === 'auth' && args[1] === 'login') {
  let stray = ''
  let prompted = false
  let line = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    if (!prompted) {
      stray += chunk
      return
    }
    line += chunk
    if (line.includes('\\n') || line.includes('\\r')) {
      const cleaned = line.replace(/[\\r\\n]+$/, '')
      record({ argv: args, tty, stray, line: cleaned, sigint: false, hasAnthropic: Boolean(process.env.ANTHROPIC_API_KEY), hasWindsurf: Boolean(process.env.WINDSURF_API_KEY) })
      process.stdout.write('DEVIN_STUB_LOGIN_ACCEPTED:' + cleaned + '\\n')
      process.exit(0)
    }
  })
  process.once('SIGINT', () => {
    record({ argv: args, tty, stray, line: null, sigint: true, hasAnthropic: Boolean(process.env.ANTHROPIC_API_KEY), hasWindsurf: Boolean(process.env.WINDSURF_API_KEY) })
    process.stdout.write('DEVIN_STUB_GOT_SIGINT\\n')
    process.exit(130)
  })
  setTimeout(() => {
    prompted = true
    process.stdout.write('DEVIN_STUB_LOGIN_READY\\n')
    process.stdout.write('Type confirmation: ')
  }, 120)
} else if (args[0] === 'auth' && args[1] === 'status') {
  const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, 'utf8').trim() : 'ok'
  record({ argv: args, tty, mode, hasAnthropic: Boolean(process.env.ANTHROPIC_API_KEY), hasWindsurf: Boolean(process.env.WINDSURF_API_KEY) })
  if (mode === 'fail') {
    process.stderr.write('DEVIN_STUB_STATUS_ERR: not logged in\\n')
    process.exit(2)
  }
  process.stdout.write('DEVIN_STUB_STATUS_OK: pty-user@example.test (Pro)\\n')
  process.stdout.write(JSON.stringify({ token: ${JSON.stringify(STATUS_SECRET_MARKER)}, secret: ${JSON.stringify(STATUS_SECRET_MARKER)} }) + '\\n')
  process.exit(0)
} else if (args[0] === 'auth' && args[1] === 'logout') {
  record({ argv: args, tty, hasAnthropic: Boolean(process.env.ANTHROPIC_API_KEY), hasWindsurf: Boolean(process.env.WINDSURF_API_KEY) })
  process.stdout.write('DEVIN_STUB_LOGOUT_OK\\n')
  process.exit(0)
} else {
  record({ argv: args, tty })
  process.exit(0)
}
`
writeFileSync(stubPath, stubScript, 'utf8')
chmodSync(stubPath, 0o755)

const sysPath = ['/usr/bin', '/bin'].filter(dir => existsSync(dir)).join(delimiter)
const childEnv: Record<string, string | undefined> = {
  ...process.env,
  MERCURY_CONFIG_DIR: configHome,
  MERCURY_CREDENTIAL_STORE: 'file',
  HOME: homeDir,
  USERPROFILE: homeDir,
  XDG_DATA_HOME: xdgData,
  XDG_CONFIG_HOME: xdgConfig,
  TMPDIR: scratch,
  PATH: `${fakeBin}${delimiter}${sysPath}`,
  TERM: 'xterm-256color',
  FORCE_COLOR: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_RECESS: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_CLIPBOARD_FILE: join(scratch, 'clipboard.txt'),
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  WINDSURF_API_KEY: AMBIENT_WINDSURF_MARKER,
}
for (const name of Object.keys(childEnv)) {
  if (/(?:OPENAI_|OPENROUTER_|GEMINI_|GOOGLE_|MOONSHOT_|DEEPSEEK_|XAI_|META_|MISTRAL_|ZAI_|HF_TOKEN)/.test(name)) {
    delete childEnv[name]
  }
}

type StubRecord = {
  argv: string[]
  mode?: string
  tty?: { stdin: boolean; stdout: boolean; stderr: boolean }
  stray?: string
  line?: string | null
  sigint?: boolean
  hasAnthropic?: boolean
  hasWindsurf?: boolean
}

function readRecords(): StubRecord[] {
  if (!existsSync(logFile)) return []
  const raw = readFileSync(logFile, 'utf8').trim()
  if (raw === '') return []
  return raw.split('\n').map(line => JSON.parse(line) as StubRecord)
}

function clearRecords(): void {
  writeFileSync(logFile, '', 'utf8')
}

function screenOf(records: readonly PtyRecord[], cols = 120, rows = 42): string {
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '))
  let r = 0
  let c = 0
  const chunks: Buffer[] = []
  for (const rec of records) {
    if (rec.direction === 'output') chunks.push(rec.bytes)
  }
  const data = Buffer.concat(chunks).toString('utf8')
  let i = 0
  while (i < data.length) {
    const ch = data[i]!
    if (ch === '\x1b') {
      const next = data[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < data.length && !/[@-~]/.test(data[j]!)) j++
        const final = data[j] ?? ''
        const body = data.slice(i + 2, j)
        const nums = body.replace(/^\?/, '').split(';').map(s => (s === '' ? 0 : Number(s)))
        if (final === 'H' || final === 'f') {
          r = Math.max(0, Math.min(rows - 1, (nums[0] || 1) - 1))
          c = Math.max(0, Math.min(cols - 1, (nums[1] || 1) - 1))
        } else if (final === 'A') {
          r = Math.max(0, r - (nums[0] || 1))
        } else if (final === 'B') {
          r = Math.min(rows - 1, r + (nums[0] || 1))
        } else if (final === 'C') {
          c = Math.min(cols - 1, c + (nums[0] || 1))
        } else if (final === 'D') {
          c = Math.max(0, c - (nums[0] || 1))
        } else if (final === 'G') {
          c = Math.max(0, Math.min(cols - 1, (nums[0] || 1) - 1))
        } else if (final === 'J') {
          if ((nums[0] || 0) === 2) {
            for (let y = 0; y < rows; y++) grid[y]!.fill(' ')
          } else {
            for (let x = c; x < cols; x++) grid[r]![x] = ' '
            for (let y = r + 1; y < rows; y++) grid[y]!.fill(' ')
          }
        } else if (final === 'K') {
          const mode = nums[0] || 0
          if (mode === 0) for (let x = c; x < cols; x++) grid[r]![x] = ' '
          else if (mode === 1) for (let x = 0; x <= c; x++) grid[r]![x] = ' '
          else if (mode === 2) grid[r]!.fill(' ')
        } else if (final === 'X') {
          const n = nums[0] || 1
          for (let x = c; x < Math.min(cols, c + n); x++) grid[r]![x] = ' '
        }
        i = j + 1
        continue
      }
      if (next === ']') {
        let j = i + 2
        while (j < data.length && data[j] !== '\x07' && !(data[j] === '\x1b' && data[j + 1] === '\\')) j++
        i = data[j] === '\x1b' ? j + 2 : j + 1
        continue
      }
      i += 2
      continue
    }
    if (ch === '\r') {
      c = 0
      i++
      continue
    }
    if (ch === '\n') {
      if (r < rows - 1) r++
      else {
        grid.shift()
        grid.push(Array.from({ length: cols }, () => ' '))
      }
      i++
      continue
    }
    if (ch >= ' ') {
      if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r]![c] = ch
      c = Math.min(cols - 1, c + 1)
    }
    i++
  }
  return grid.map(line => line.join('').trimEnd()).join('\n')
}

function textSince(records: readonly PtyRecord[], fromIndex: number): string {
  const chunks: Buffer[] = []
  for (let i = fromIndex; i < records.length; i++) {
    if (records[i]!.direction === 'output') chunks.push(records[i]!.bytes)
  }
  const raw = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.max(1, Number(n || 1))))
    .replace(/\x1b\[\d*(?:;\d*)*[HfGX]/g, ' ')
  return stripAnsi(raw).replace(/\s+/g, ' ')
}

async function waitForOutput(
  records: readonly PtyRecord[],
  fromIndex: number,
  predicate: (text: string) => boolean,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; text: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = textSince(records, fromIndex)
    if (predicate(text)) return { ok: true, text }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  return { ok: false, text: textSince(records, fromIndex) }
}

async function waitForScreen(
  records: readonly PtyRecord[],
  predicate: (screen: string) => boolean,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; text: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const screen = screenOf(records).replace(/\s+/g, ' ')
    if (predicate(screen)) return { ok: true, text: screen }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  return { ok: false, text: screenOf(records).replace(/\s+/g, ' ') }
}

async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

try {
  console.log('§1 — BOOT LOGINS/KEYS REAL PTY HANDOFF (login, cancel, native status, logout confirm, failure)')
  {
    clearRecords()
    writeFileSync(statusModeFile, 'ok', 'utf8')
    const pty = recordPty({
      argv: [NODE, BIN],
      cwd: cwdDir,
      env: childEnv,
      cols: 120,
      rows: 42,
      path: recBoot,
    })
    try {
      const bootReady = await waitForOutput(pty.records, 0, text => text.includes('Logins/Keys'), 20_000)
      check('compiled Mercury paints Boot face with Logins/Keys and zero devin invocations', bootReady.ok && readRecords().length === 0)

      const beforeLogins = pty.records.length
      pty.send('\x1b[B')
      await pause(120)
      pty.send('\r')
      const loginsUp = await waitForOutput(pty.records, beforeLogins, text => text.includes('Families') && text.includes('22'), 10_000)
      check('opening Logins/Keys shows Families 22 with zero devin invocations', loginsUp.ok && readRecords().length === 0)

      pty.send('\x1b[F')
      const devinFocused = await waitForScreen(pty.records, text => text.includes('Devin CLI (external agent)') && text.includes('/crew attach devin'), 6_000)
      check('End focuses Devin CLI (external agent) row with zero devin invocations', devinFocused.ok && readRecords().length === 0)

      pty.send('\r')
      const pickUp = await waitForScreen(pty.records, text => text.includes('devin auth login') && text.includes('devin auth status') && text.includes('devin auth logout'), 6_000)
      check('Enter opens Devin CLI choice list with zero devin invocations', pickUp.ok && readRecords().length === 0)

      const beforeLogin = pty.records.length
      pty.send('\r')
      const stubPrompt = await waitForOutput(pty.records, beforeLogin, text => text.includes('DEVIN_STUB_LOGIN_READY') && text.includes('Type confirmation:'), 8_000)
      check('selecting devin auth login hands real foreground PTY to devin executable', stubPrompt.ok)

      const beforeType = pty.records.length
      pty.send('ok-human-42\r')
      const returned = await waitForScreen(
        pty.records,
        text => text.includes('devin auth login finished (exit 0)') && text.includes('Credentials stay with Devin CLI'),
        10_000,
      )
      const calls1 = readRecords()
      const typedEchoed = textSince(pty.records, beforeType).includes('ok-human-42')
      check(
        'interactive devin auth login received real TTY, zero leaked scene keys, echoed user input, stripped Mercury/WINDSURF credentials, and returned cleanly without falsely claiming signed in',
        returned.ok &&
          typedEchoed &&
          calls1.length === 1 &&
          calls1[0]!.argv[1] === 'login' &&
          calls1[0]!.tty?.stdin === true &&
          calls1[0]!.tty?.stdout === true &&
          calls1[0]!.tty?.stderr === true &&
          calls1[0]!.stray === '' &&
          calls1[0]!.line === 'ok-human-42' &&
          calls1[0]!.hasAnthropic === false &&
          calls1[0]!.hasWindsurf === false &&
          !returned.text.includes('Signed in as') &&
          !returned.text.includes(AMBIENT_WINDSURF_MARKER),
        `returned=${returned.ok} echoed=${typedEchoed} calls=${JSON.stringify(calls1)}`,
      )

      pty.send('\r')
      const backRoster = await waitForScreen(pty.records, text => text.includes('External agent') && !text.includes('devin auth login finished'), 6_000)
      check('Mercury regains raw-mode keyboard input after PTY handoff (Enter dismisses receipt)', backRoster.ok)

      pty.send('\r')
      await waitForScreen(pty.records, text => text.includes('Sign in with Devin CLI (devin auth login)'), 6_000)
      const beforeCancelRun = pty.records.length
      pty.send('\r')
      await waitForOutput(pty.records, beforeCancelRun, text => text.includes('DEVIN_STUB_LOGIN_READY'), 8_000)
      pty.send('\x03')
      const cancelled = await waitForScreen(pty.records, text => text.includes('devin auth login was cancelled'), 10_000)
      const calls2 = readRecords()
      check(
        'Ctrl-C cancels foreground devin auth login without killing Mercury and returns cleanly with honest cancellation receipt',
        cancelled.ok && calls2.length === 2 && calls2[1]!.sigint === true,
        `cancelled=${cancelled.ok} calls=${JSON.stringify(calls2)}`,
      )

      pty.send('\x1b')
      const backAfterCancel = await waitForScreen(pty.records, text => text.includes('External agent') && !text.includes('devin auth login was cancelled'), 6_000)
      check('Mercury keyboard input still works cleanly after Ctrl-C cancellation return', backAfterCancel.ok)

      pty.send('\r')
      await waitForScreen(pty.records, text => text.includes('Check Devin CLI status'), 6_000)
      pty.send('\x1b[B')
      await pause(80)
      const beforeStatus = pty.records.length
      pty.send('\r')
      const nativeStatus = await waitForOutput(
        pty.records,
        beforeStatus,
        text => text.includes('DEVIN_STUB_STATUS_OK: pty-user@example.test') && text.includes('Press Enter to return to Mercury'),
        8_000,
      )
      check('explicit devin auth status shows native CLI status in terminal and waits for Enter so operator can read it', nativeStatus.ok, nativeStatus.text.slice(-260))

      pty.send('\r')
      const statusReturned = await waitForScreen(pty.records, text => text.includes('devin auth status finished (exit 0).'), 8_000)
      const calls3 = readRecords()
      check(
        'after Enter, Mercury shows only the short status exit outcome and captures ZERO CLI output or secret marker on screen',
        statusReturned.ok &&
          calls3.length === 3 &&
          calls3[2]!.argv[1] === 'status' &&
          calls3[2]!.hasAnthropic === false &&
          calls3[2]!.hasWindsurf === false &&
          !statusReturned.text.includes(STATUS_SECRET_MARKER) &&
          !statusReturned.text.includes('pty-user@example.test'),
        `returned=${statusReturned.ok} screen=${statusReturned.text.slice(-260)}`,
      )

      pty.send('\r')
      await waitForScreen(pty.records, text => text.includes('External agent') && !text.includes('devin auth status finished'), 6_000)

      writeFileSync(statusModeFile, 'fail', 'utf8')
      pty.send('\r')
      await waitForScreen(pty.records, text => text.includes('Check Devin CLI status'), 6_000)
      pty.send('\x1b[B')
      await pause(80)
      const beforeFailStatus = pty.records.length
      pty.send('\r')
      const failNative = await waitForOutput(pty.records, beforeFailStatus, text => text.includes('DEVIN_STUB_STATUS_ERR') && text.includes('exited 2'), 8_000)
      pty.send('\r')
      const failReturned = await waitForScreen(pty.records, text => text.includes('devin auth status exited with code 2.'), 8_000)
      check('failed devin auth status shows native error in terminal and truthful exit-code receipt in Mercury', failNative.ok && failReturned.ok && !failReturned.text.includes('DEVIN_STUB_STATUS_ERR'))
      writeFileSync(statusModeFile, 'ok', 'utf8')
      pty.send('\r')
      await waitForScreen(pty.records, text => text.includes('External agent') && !text.includes('exited with code 2'), 6_000)

      pty.send('\r')
      await waitForScreen(pty.records, text => text.includes('Sign out of Devin CLI'), 6_000)
      pty.send('\x1b[B')
      await pause(60)
      pty.send('\x1b[B')
      await pause(60)
      pty.send('\r')
      const logoutConfirm = await waitForScreen(pty.records, text => text.includes('Confirm sign out (devin auth logout)'), 6_000)
      check('destructive logout prompts confirmation before spawning anything', logoutConfirm.ok && readRecords().length === 4)
      pty.send('\x1b[B')
      await pause(60)
      const beforeLogout = pty.records.length
      pty.send('\r')
      const logoutNative = await waitForOutput(pty.records, beforeLogout, text => text.includes('DEVIN_STUB_LOGOUT_OK') && text.includes('Press Enter to return to Mercury'), 8_000)
      pty.send('\r')
      const logoutReturned = await waitForScreen(pty.records, text => text.includes('devin auth logout finished (exit 0).'), 8_000)
      const calls5 = readRecords()
      check('confirmed logout runs devin auth logout once in terminal and returns with short non-secret outcome', logoutNative.ok && logoutReturned.ok && calls5.length === 5 && calls5[4]!.argv[1] === 'logout' && calls5[4]!.hasWindsurf === false && !logoutReturned.text.includes('DEVIN_STUB_LOGOUT_OK'))
    } finally {
      await pty.close()
    }
  }

  console.log('§2 — CHAT /logins REAL PTY HANDOFF (compiled dist/mercury.mjs)')
  {
    clearRecords()
    const pty = recordPty({
      argv: [NODE, BIN],
      cwd: cwdDir,
      env: childEnv,
      cols: 120,
      rows: 42,
      path: recChat,
    })
    try {
      await waitForOutput(pty.records, 0, text => text.includes('New Session'), 20_000)
      const beforeSession = pty.records.length
      pty.send('\r')
      const chatReady = await waitForOutput(pty.records, beforeSession, text => text.includes('❯') || text.includes('/help'), 20_000)
      await pause(500)
      check('compiled Mercury enters interactive chat session with zero devin invocations', chatReady.ok && readRecords().length === 0)

      pty.send('/logins devin')
      await pause(300)
      pty.send('\r')
      const popupUp = await waitForScreen(pty.records, text => text.includes('Devin CLI (external agent)'), 12_000)
      check('/logins devin opens popup showing Devin CLI (external agent) with zero devin invocations', popupUp.ok && readRecords().length === 0)

      pty.send('\r')
      const cardUp = await waitForScreen(pty.records, text => text.includes('devin auth login') && text.includes('devin auth status'), 6_000)
      check('/logins Devin CLI card opens with zero devin invocations', cardUp.ok && readRecords().length === 0)

      const beforeChatLogin = pty.records.length
      pty.send('\r')
      const chatStubReady = await waitForOutput(pty.records, beforeChatLogin, text => text.includes('DEVIN_STUB_LOGIN_READY'), 8_000)
      check('/logins devin auth login hands real foreground PTY to devin executable', chatStubReady.ok)

      const beforeChatType = pty.records.length
      pty.send('chat-human-99\r')
      const chatReturned = await waitForScreen(
        pty.records,
        text => text.includes('devin auth login finished (exit 0)') && text.includes('Credentials stay with Devin CLI'),
        10_000,
      )
      const chatCalls = readRecords()
      const chatEchoed = textSince(pty.records, beforeChatType).includes('chat-human-99')
      check(
        '/logins interactive handoff gave real TTY, zero leaked keys, echoed input, stripped Mercury/WINDSURF credentials, and returned cleanly inside /logins popup',
        chatReturned.ok &&
          chatEchoed &&
          chatCalls.length === 1 &&
          chatCalls[0]!.tty?.stdin === true &&
          chatCalls[0]!.tty?.stdout === true &&
          chatCalls[0]!.tty?.stderr === true &&
          chatCalls[0]!.stray === '' &&
          chatCalls[0]!.line === 'chat-human-99' &&
          chatCalls[0]!.hasAnthropic === false &&
          chatCalls[0]!.hasWindsurf === false,
        `returned=${chatReturned.ok} echoed=${chatEchoed} calls=${JSON.stringify(chatCalls)}`,
      )

      pty.send('\r')
      const backToCard = await waitForScreen(pty.records, text => text.includes('devin auth status') && !text.includes('devin auth login finished'), 6_000)
      check('/logins popup regains keyboard input after PTY handoff', backToCard.ok)
    } finally {
      await pty.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-devin-cli-pty-drive: ALL PASS' : `\nprove-devin-cli-pty-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
