#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'
import { teeBytes } from './appleTerminalReading.ts'
import { fixture, ROOT } from './viewportFixture.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'colour-answer-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'proof-home')
process.env.NODE_ENV = 'test'
process.env.TERM = 'xterm-256color'
for (const name of ['COLORTERM', 'FORCE_COLOR', 'NO_COLOR', 'TMUX', 'TERM_PROGRAM', 'MERCURY_TRUECOLOR', 'WT_SESSION', 'KITTY_WINDOW_ID']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const DIST = join(ROOT, 'dist', 'mercury.mjs')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 600) : ''}`)
}
function section(title: string): void {
  console.log('\n' + title)
}

console.log('prove-terminal-answers-truecolor — Mercury asks the terminal for 24-bit colour once, before anything is painted, and no byte of the answer is typed')

const ESC = '\x1b'
const ST = ESC + '\\'
const ECHO = `${ESC}P1$r0;48:2::1:2:3m${ST}`
const ECHO_SEMICOLONS = `${ESC}P1$r48;2;1;2;3m\x07`
const ZERO = `${ESC}P1$r0m${ST}`
const REFUSED = `${ESC}P0$r${ST}`
const ASKED = `${ESC}P$qm`

const colorize = await import('../../src/screen/renderer/colorize.ts')
const interpreter = await import('../../src/screen/renderer/input/interpreter.ts')
const decoder = await import('../../src/screen/renderer/input/input-decoder.ts')
const early = await import('../../src/boot/earlyInput.ts')
const profile = await import('../../src/screen/renderer/terminal-session/terminalProfile.ts')
const { InputEvent } = await import('../../src/screen/renderer/events/input-event.ts')
const chalk = (await import('chalk')).default

const COLORIZE = 'src/screen/renderer/colorize.ts'

section('§1 the request sets a colour, asks what stands, and puts back what stood')
{
  const query: unknown = (colorize as Record<string, unknown>).TRUECOLOR_QUERY
  check('the request is one string of the depth owner', typeof query === 'string', `TRUECOLOR_QUERY must be exported from ${COLORIZE}`)
  const q = typeof query === 'string' ? query : ''
  check('it saves the cursor and attributes, sets a 24-bit background, asks for the graphic rendition, and restores', q === `${ESC}7${ESC}[48;2;1;2;3m${ESC}P$qm${ST}${ESC}8`, `TRUECOLOR_QUERY in ${COLORIZE} must be ESC 7, CSI 48;2;1;2;3 m, DCS $ q m ST, ESC 8; got ${JSON.stringify(q)}`)
  check('nothing printable stands outside the escape sequences', q.replace(/\x1b\[[0-9;]*m|\x1bP[^\x1b]*\x1b\\|\x1b[78]/g, '') === '', `TRUECOLOR_QUERY in ${COLORIZE} must hold control sequences only; left over: ${JSON.stringify(q.replace(/\x1b\[[0-9;]*m|\x1bP[^\x1b]*\x1b\\|\x1b[78]/g, ''))}`)
}

section('§2 only an echo of the colour that was set counts')
{
  const echo = (colorize as { truecolorEcho?: (setting: string) => boolean }).truecolorEcho
  const says = (setting: string): boolean | undefined => echo?.(setting)
  const fix = `truecolorEcho in ${COLORIZE} must accept only a report whose background is 48 2 … 1 2 3`
  check('colon form with an empty colour space', says('0;48:2::1:2:3m') === true, fix)
  check('colon form without a colour space', says('48:2:1:2:3m') === true, fix)
  check('semicolon form', says('0;48;2;1;2;3m') === true, fix)
  check('beside the launcher\'s park ink', says('0;8;30;48:2::1:2:3m') === true, fix)
  check('a bare reset is no echo (the VS Code terminal\'s answer)', says('0m') === false, fix)
  check('an indexed background is no echo', says('0;48:5:16m') === false, fix)
  check('the same numbers as a foreground are no echo', says('0;38:2::1:2:3m') === false, fix)
  check('another colour is no echo', says('0;48:2::1:2:30m') === false, fix)
  check('an empty report is no echo', says('') === false, fix)
}

section('§3 the answer is a terminal response, in one piece or split, and never a key')
{
  const typedOf = (atoms: Awaited<ReturnType<typeof decoder.parseMultipleKeypresses>>[0]): string => {
    let out = ''
    for (const atom of atoms) {
      if (atom.kind !== 'key') continue
      const event = new InputEvent(atom)
      const k = event.key
      if (k.ctrl || k.meta || k.return || k.escape || k.tab || k.backspace || k.delete || k.upArrow || k.downArrow || k.leftArrow || k.rightArrow) continue
      out += event.input
    }
    return out
  }
  const feedAll = (feeds: Array<string | null>, owed: boolean): { typed: string; responses: number } => {
    let state: typeof decoder.INITIAL_STATE = { ...decoder.INITIAL_STATE, stringReplyOwed: () => owed }
    let typed = ''
    let responses = 0
    for (const feed of feeds) {
      const [atoms, next] = decoder.parseMultipleKeypresses(state, feed)
      typed += typedOf(atoms)
      responses += atoms.filter(a => a.kind === 'response').length
      state = next
    }
    return { typed, responses }
  }
  const fixKnow = 'interpretResponse in src/screen/renderer/input/interpreter.ts must know DCS 0|1 $ r … ST as a terminal response'
  const fixHead = 'the reply-head rules in src/screen/renderer/input/scanner.ts (isReplyBody, REPLY_STRING_HEAD) must take P0$ and P1$ beside P>'
  for (const [name, reply] of [['an echo', ECHO], ['an echo ended by BEL', ECHO_SEMICOLONS], ['a bare reset', ZERO], ['a refusal', REFUSED]] as const) {
    const whole = interpreter.interpretResponse(reply)
    check(`${name} is read as a response`, whole !== null && (whole as { type: string }).type === 'decrqss', `${fixKnow}; got ${JSON.stringify(whole)}`)
    const late = feedAll([reply, 'zq'], false)
    check(`${name} arriving whole after the screen is up types nothing`, late.typed === 'zq' && late.responses === 1, `${fixKnow}; typed ${JSON.stringify(late.typed)}, ${late.responses} responses`)
    for (const cut of [1, 2, 3, 4]) {
      const split = feedAll([reply.slice(0, cut), null, reply.slice(cut), null, 'zq'], false)
      check(`${name} cut after ${cut} byte${cut === 1 ? '' : 's'} with a flush between types nothing`, split.typed === 'zq', `${fixHead}; typed ${JSON.stringify(split.typed)}`)
    }
  }
  const version = interpreter.interpretResponse(`${ESC}P>|iTerm2 3.5.14${ST}`)
  check('a version answer is still a version answer', version !== null && version.type === 'xtversion', 'XTVERSION_RE in src/screen/renderer/input/interpreter.ts must still come first for DCS > |')
}

section('§4 the early input capture swallows the answer and keeps what was typed around it')
{
  const drive = (chunks: string[]): { draft: string; held: unknown } => {
    early.seedEarlyInput('')
    let held: unknown = ''
    for (const chunk of chunks) held = early.__processEarlyChunkForTest((typeof held === 'string' ? held : '') + chunk)
    return { draft: early.consumeEarlyInput(), held }
  }
  const fix = 'readEarlyChunk in src/boot/earlyInput.ts must swallow a DCS string whole and hand back an unfinished reply head to be joined with the next chunk'
  check('an answer between typed letters leaves the letters alone', drive([`ab${ECHO}cd`]).draft === 'abcd', `${fix}; draft ${JSON.stringify(drive([`ab${ECHO}cd`]).draft)}`)
  check('a BEL-ended answer too', drive([`ab${ECHO_SEMICOLONS}cd`]).draft === 'abcd', `${fix}; draft ${JSON.stringify(drive([`ab${ECHO_SEMICOLONS}cd`]).draft)}`)
  for (const cut of [5, 9, ECHO.length - 1]) {
    const got = drive([`ab${ECHO.slice(0, cut)}`, `${ECHO.slice(cut)}cd`])
    check(`an answer cut after ${cut} bytes across two reads types nothing`, got.draft === 'abcd' && got.held === '', `${fix}; draft ${JSON.stringify(got.draft)}, held ${JSON.stringify(got.held)}`)
  }
  check('alt+P then typing is not held as an answer', drive([`${ESC}Phello`]).draft === 'hello', `${fix}; an ESC P with no reply head and no terminator must drop only the P; draft ${JSON.stringify(drive([`${ESC}Phello`]).draft)}`)
  check('an arrow key still seeds nothing', drive([`a${ESC}[Ab`]).draft === 'ab', `${fix}; draft ${JSON.stringify(drive([`a${ESC}[Ab`]).draft)}`)
}

section('§5 who is asked: nobody whose depth the environment already settles')
{
  const askable = (colorize as { truecolorAskable?: (env: Record<string, string | undefined>) => boolean }).truecolorAskable
  const at = (level: 0 | 1 | 2 | 3, env: Record<string, string | undefined>): boolean | undefined => {
    const saved = chalk.level
    chalk.level = level
    try {
      return askable?.(env)
    } finally {
      chalk.level = saved
    }
  }
  const fix = `truecolorAskable in ${COLORIZE}`
  check('a 256-colour terminal with nothing said is asked', at(2, { TERM: 'xterm-256color' }) === true, `${fix} must be true at level 2 with a plain TERM`)
  check('a 16-colour terminal is asked (docker exec hands TERM=xterm)', at(1, { TERM: 'xterm' }) === true, `${fix} must be true at level 1 with TERM=xterm`)
  check('a terminal the colour library does not know is asked', at(0, { TERM: 'alacritty' }) === true, `${fix} must be true at level 0 with an unknown TERM`)
  check('a terminal already at 24-bit is not asked (every supported Windows build is here)', at(3, { TERM: 'xterm-256color' }) === false, `${fix} must be false at level 3`)
  check('no TERM, not asked (the old Windows console)', at(1, {}) === false, `${fix} must be false with TERM unset`)
  check('the Linux console is not asked', at(1, { TERM: 'linux' }) === false, `${fix} must be false for TERM=linux: its DCS is not implemented`)
  check('TERM=dumb is not asked', at(0, { TERM: 'dumb' }) === false, `${fix} must be false for TERM=dumb`)
  check('tmux is not asked', at(2, { TERM: 'tmux-256color', TMUX: '/tmp/tmux-1/default,1,0' }) === false, `${fix} must be false under TMUX`)
  check('Apple Terminal by name is not asked', at(2, { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }) === false, `${fix} must be false for TERM_PROGRAM=Apple_Terminal`)
  check('NO_COLOR is not asked', at(0, { TERM: 'xterm-256color', NO_COLOR: '1' }) === false, `${fix} must be false under NO_COLOR`)
  check('FORCE_COLOR is not asked', at(2, { TERM: 'xterm-256color', FORCE_COLOR: '2' }) === false, `${fix} must be false when FORCE_COLOR is set`)
}

section('§6 one reader raises the depth, and the health words and the profile row say why')
{
  const take = (colorize as { takeTruecolorAnswer?: (setting: string) => boolean }).takeTruecolorAnswer
  const saved = chalk.level
  const levelNow = (): number => chalk.level
  chalk.level = 2
  const fix = `takeTruecolorAnswer in ${COLORIZE}`
  check('a bare reset raises nothing', take?.('0m') === false && levelNow() === 2, `${fix} must leave the level alone without an echo`)
  check('an echo raises the depth to 24-bit', take?.('0;48:2::1:2:3m') === true && levelNow() === 3, `${fix} must set level 3 on an echo; level ${levelNow()}`)
  check('the health words say the terminal answered', colorize.colorDepthWhy().includes('answered'), `colorDepthWhy in ${COLORIZE} must say the terminal answered; got: ${colorize.colorDepthWhy()}`)
  const row = profile.resolveTerminalProfile({ platform: 'linux', isTTY: true, syncOutput: true, extendedKeys: true, hyperlinks: true, progress: true }).checks.find(c => c.id === 'truecolor')
  check('the profile\'s 24-bit row is met, with the answer as its evidence', row !== undefined && row.ok && row.evidence.includes('answered'), `the truecolor check in src/screen/renderer/terminal-session/terminalProfile.ts must be ok on an answer; evidence: ${row?.evidence}`)
  const injected = profile.resolveTerminalProfile({ env: { TERM: 'xterm-256color' }, platform: 'linux', isTTY: true, syncOutput: true, extendedKeys: true, hyperlinks: true, progress: true }).checks.find(c => c.id === 'truecolor')
  check('a profile resolved for another environment does not borrow this session\'s answer', injected !== undefined && !injected.ok, `the truecolor check must read the answer only for the live environment; evidence: ${injected?.evidence}`)
  chalk.level = saved
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`\nprove-terminal-answers-truecolor: the terminal arms are SKIPPED — no POSIX pty capture driver on this host (${driver.kind})`)
  console.log(`\n${failures === 0 ? 'ALL HOLD' : `${failures} FAILED`} (${checks} checks)`)
  process.exit(failures === 0 ? 0 : 1)
}
if (!existsSync(DIST)) {
  console.log('\nprove-terminal-answers-truecolor: the terminal arms are SKIPPED — dist/mercury.mjs absent (bun run build.ts first)')
  console.log(`\n${failures === 0 ? 'ALL HOLD' : `${failures} FAILED`} (${checks} checks)`)
  process.exit(failures === 0 ? 0 : 1)
}
const node = Bun.which('node')
if (!node) throw new Error('node is required')
const pty = driver

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Arm = { name: string; marks: Map<string, Grid>; bytes: string; status: number | null; log: string; settledAfterMs: number[]; importMs: number[] }
type Plan = { name: string; env: Record<string, string | undefined>; reply?: string; lateReply?: string; upTo: 'boot' | 'typed'; verb?: { args: string[]; prints: string } }

async function capture(plan: Plan): Promise<Arm> {
  const world = fixture(scratch)
  const env: NodeJS.ProcessEnv = { ...world.env, MERCURY_PROFILE_STARTUP: '1' }
  delete env.COLORTERM
  delete env.FORCE_COLOR
  for (const [key, value] of Object.entries(plan.env)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const tee = join(scratch, `${plan.name}.tee.bin`)
  env.VSHOT_TEE = tee
  const out = join(scratch, `${plan.name}.json`)
  const gate = { requireAwait: true, minTick: 3, awaitSettleTicks: 5 }
  const sends: Array<Record<string, unknown>> = []
  if (plan.reply !== undefined) sends.push({ requireAwait: true, awaitRaw: ASKED, data: plan.reply })
  if (plan.verb === undefined) {
    sends.push({ ...gate, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, data: '', mark: 'boot' })
    if (plan.upTo === 'typed') {
      sends.push({ ...gate, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, data: '\r' })
      sends.push({ ...gate, awaitText: 'Type a prompt', awaitSettleTicks: 12, data: plan.lateReply ?? '', mark: 'session' })
      sends.push({ requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'zq' })
      sends.push({ requireAwait: true, awaitText: 'zq', awaitSettleTicks: 4, data: '', mark: 'typed' })
    }
  }
  const readyText = plan.verb?.prints ?? (plan.upTo === 'typed' ? 'zq' : '↑↓')
  const cfgFile = join(scratch, `${plan.name}.capture.json`)
  writeFileSync(cfgFile, JSON.stringify({ argv: [node, DIST, ...(plan.verb?.args ?? [])], cwd: world.cwd, cols: 120, rows: 40, total: plan.verb === undefined ? 300 : 100, sends, readyText, readySettleTicks: 3, out }))
  const child = spawn(pty.python, [captureEngineEntry(pty, ROOT), cfgFile], { cwd: world.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += String(bytes) })
  child.stderr.on('data', bytes => { log += String(bytes) })
  const status = await new Promise<number | null>(resolveStatus => {
    const wall = setTimeout(() => { log += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(180_000))
    child.once('error', error => { log += String(error) })
    child.once('close', code => { clearTimeout(wall); resolveStatus(code) })
  })
  const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }> }) : null
  const marks = new Map<string, Grid>((payload?.marks ?? []).map(m => [m.label, m.grid]))
  const bytes = existsSync(tee) ? Buffer.from(teeBytes(readFileSync(tee))).toString('latin1') : ''
  const settledAfterMs: number[] = []
  const importMs: number[] = []
  const perf = join(world.config, 'startup-perf')
  for (const file of existsSync(perf) ? readdirSync(perf) : []) {
    const text = readFileSync(join(perf, file), 'utf8')
    const settled = /\(\+([\d.]+)ms\) terminal_depth_settled/.exec(text)
    const before = /\[\+([\d.]+)ms\] \(\+[\d.]+ms\) before_main_import/.exec(text)
    const after = /\[\+([\d.]+)ms\] \(\+[\d.]+ms\) after_main_import/.exec(text)
    if (settled) settledAfterMs.push(Number(settled[1]))
    if (before && after) importMs.push(Number(after[1]) - Number(before[1]))
  }
  return { name: plan.name, marks, bytes, status, log, settledAfterMs, importMs }
}

const asks = (arm: Arm): number => arm.bytes.split(ASKED).length - 1
const afterAsk = (arm: Arm): string => (arm.bytes.includes(ASKED) ? arm.bytes.slice(arm.bytes.indexOf(ASKED) + ASKED.length) : arm.bytes)
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length
const inks = (grid: Grid | undefined): Set<string> => new Set((grid ?? []).flat().filter(cell => (cell.c || ' ') !== ' ').map(cell => cell.fg))
const rowWith = (grid: Grid | undefined, needle: string): string => (grid ?? []).map(row => row.map(cell => cell.c || ' ').join('')).find(line => line.includes(needle)) ?? ''
const MUTED = '71807b'
const BRAND = 'dd4444'
const MUTED_256 = '87af87'
const BRAND_256 = 'd75f5f'
const fixAsk = 'startCapturingEarlyInput in src/boot/earlyInput.ts writes TRUECOLOR_QUERY once for a bare session when truecolorAskable says so, and src/boot/entrypoints/cli.tsx awaits the answer before main()'

function fullDepth(arm: Arm, why: string): void {
  check(`${arm.name}: the capture ended cleanly and reached its marks`, arm.status === 0 && arm.marks.has('boot'), `build dist/mercury.mjs with bun run build.ts and read the log: ${arm.log.slice(-300)}`)
  check(`${arm.name}: the request was written exactly once`, asks(arm) === 1, `${fixAsk}; found ${asks(arm)}`)
  const after = afterAsk(arm)
  check(`${arm.name}: every colour code after the answer is 24-bit (${why})`, count(after, /[34]8;2;\d/g) > 100 && count(after, /[34]8;5;\d/g) === 0, `takeTruecolorAnswer in ${COLORIZE} must raise the depth before anything is rendered; 24-bit ${count(after, /[34]8;2;\d/g)}, 256-colour ${count(after, /[34]8;5;\d/g)}`)
  const boot = inks(arm.marks.get('boot'))
  check(`${arm.name}: the Boot face's muted ink is the theme's grey and its brand ink the theme's red, by its cells`, boot.has(MUTED) && boot.has(BRAND) && !boot.has(MUTED_256) && !boot.has(BRAND_256), `the Boot face must be painted at 24-bit; inks ${[...boot].slice(0, 12).join(' ')}`)
}

function keptDepth(arm: Arm, why: string): void {
  check(`${arm.name}: the capture ended cleanly and reached its marks`, arm.status === 0 && arm.marks.has('boot'), `build dist/mercury.mjs with bun run build.ts and read the log: ${arm.log.slice(-300)}`)
  const after = afterAsk(arm)
  check(`${arm.name}: no 24-bit code is written (${why})`, count(after, /[34]8;2;\d/g) === 0 && count(after, /[34]8;5;\d/g) > 100, `only an echo may raise the depth; 24-bit ${count(after, /[34]8;2;\d/g)}, 256-colour ${count(after, /[34]8;5;\d/g)}`)
  const boot = inks(arm.marks.get('boot'))
  check(`${arm.name}: the Boot face keeps the 256-colour ink, by its cells`, !boot.has(MUTED) && !boot.has(BRAND), `the Boot face must stay at 256 colours; inks ${[...boot].slice(0, 12).join(' ')}`)
}

function composerClean(arm: Arm): void {
  const line = rowWith(arm.marks.get('typed'), 'zq')
  check(`${arm.name}: what is typed after the answer is what the composer holds, and nothing else`, /❯ zq\s*│/.test(line), `no byte of the answer may reach the composer; its row reads ${JSON.stringify(line.trim().slice(0, 80))}`)
}

section('§7 a terminal that echoes: 24-bit from the first painted cell')
const echo = await capture({ name: 'echo', env: { TERM: 'xterm-256color' }, reply: ECHO, upTo: 'typed' })
fullDepth(echo, 'TERM=xterm-256color, what SSH hands over')
composerClean(echo)
const echoBel = await capture({ name: 'echo-semicolons-bel', env: { TERM: 'xterm-256color' }, reply: ECHO_SEMICOLONS, upTo: 'boot' })
fullDepth(echoBel, 'the semicolon form, ended by BEL')
const echoXterm = await capture({ name: 'echo-xterm', env: { TERM: 'xterm' }, reply: ECHO, upTo: 'boot' })
fullDepth(echoXterm, 'TERM=xterm, what docker exec hands over')

section('§8 a terminal that answers something else, or nothing: today\'s depth, and the first paint is not held')
const zero = await capture({ name: 'bare-reset', env: { TERM: 'xterm-256color' }, reply: ZERO, upTo: 'typed' })
keptDepth(zero, 'the answer was 0m')
composerClean(zero)
const refused = await capture({ name: 'refused', env: { TERM: 'xterm-256color' }, reply: REFUSED, upTo: 'boot' })
keptDepth(refused, 'the request was refused')
const silent = await capture({ name: 'silent', env: { TERM: 'xterm-256color' }, upTo: 'typed' })
keptDepth(silent, 'the terminal answered nothing')
check('silent: the request was written exactly once', asks(silent) === 1, `${fixAsk}; found ${asks(silent)}`)
composerClean(silent)
const late = await capture({ name: 'late-echo', env: { TERM: 'xterm-256color' }, lateReply: ECHO, upTo: 'typed' })
keptDepth(late, 'the echo came after the session screen was up')
composerClean(late)
{
  const waits = [...echo.settledAfterMs, ...zero.settledAfterMs, ...silent.settledAfterMs, ...late.settledAfterMs]
  const imports = [...silent.importMs, ...late.importMs]
  const worst = Math.max(0, ...waits)
  console.log(`  measured: the wait behind the main module's load, per process: ${waits.map(ms => ms.toFixed(1)).join(' ')} ms · the load itself: ${imports.map(ms => ms.toFixed(0)).join(' ')} ms`)
  check('the wait for the answer was measured in every arm that asked', waits.length >= 4, `src/boot/entrypoints/cli.tsx must stamp terminal_depth_settled behind after_main_import; ${waits.length} stamps read`)
  check('a terminal that answers nothing holds the start no longer than the bound of 100 ms after the request', worst <= 100, `DEPTH_ANSWER_MS in src/boot/earlyInput.ts bounds the wait from the request; the longest wait behind the load was ${worst.toFixed(1)} ms`)
}

section('§9 nobody is asked whose depth is settled, and a verb is never asked')
for (const [name, env] of [
  ['colorterm-truecolor', { TERM: 'xterm-256color', COLORTERM: 'truecolor' }],
  ['truecolor-flag-off', { TERM: 'xterm-256color', MERCURY_TRUECOLOR: '0' }],
  ['no-color', { TERM: 'xterm-256color', NO_COLOR: '1' }],
  ['tmux', { TERM: 'tmux-256color', TMUX: '/tmp/tmux-1/default,1,0' }],
  ['linux-console', { TERM: 'linux' }],
  ['apple-terminal', { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }],
] as const) {
  const arm = await capture({ name, env, upTo: 'boot' })
  check(`${name}: the Boot face came up and no request was written`, arm.status === 0 && arm.marks.has('boot') && asks(arm) === 0, `truecolorAskable in ${COLORIZE} must be false here; ${asks(arm)} requests; marks ${[...arm.marks.keys()].join(',')}; ${arm.log.slice(-200)}`)
}
const help = await capture({ name: 'verb-help', env: { TERM: 'xterm-256color' }, upTo: 'boot', verb: { args: ['--help'], prints: 'Usage: mercury' } })
check('--help: its words are printed and no request is written', help.bytes.includes('Usage: mercury') && asks(help) === 0, `only a bare session asks (src/boot/entrypoints/cli.tsx); ${asks(help)} requests in ${help.bytes.length} bytes`)
const verb = await capture({ name: 'verb-extensions', env: { TERM: 'xterm-256color' }, upTo: 'boot', verb: { args: ['extensions', 'list'], prints: 'filmcraft' } })
check('a verb: its rows are printed and no request is written', verb.bytes.includes('filmcraft') && asks(verb) === 0, `only a bare session asks (src/boot/entrypoints/cli.tsx); ${asks(verb)} requests in ${verb.bytes.length} bytes`)

section('§10 MERCURY_TRUECOLOR=1 is the override at TERM=xterm too')
const forced = await capture({ name: 'forced-xterm', env: { TERM: 'xterm', MERCURY_TRUECOLOR: '1' }, upTo: 'boot' })
check('forced-xterm: the Boot face came up and no request was written', forced.status === 0 && forced.marks.has('boot') && asks(forced) === 0, `an override settles the depth, so nothing is asked; ${asks(forced)} requests; ${forced.log.slice(-200)}`)
{
  const boot = inks(forced.marks.get('boot'))
  check('forced-xterm: the Boot face is painted at 24-bit, by its cells', boot.has(MUTED) && boot.has(BRAND), `boostChalkLevelForMercury in ${COLORIZE} must raise level 1 as it raises level 2; inks ${[...boot].slice(0, 12).join(' ')}`)
}

if (failures === 0) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nscratch kept: ${scratch}`)
console.log(`\n${failures === 0 ? 'ALL HOLD' : `${failures} FAILED`} (${checks} checks)`)
process.exit(failures === 0 ? 0 : 1)
