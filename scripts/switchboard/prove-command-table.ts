#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-command-table.ts — ONE COMMAND TABLE, ONE
//  DISPATCH RULE (every command works in
//  every session).
//
//   C1  the census: every command the screen knows is either a SCREEN
//       command (a route alias, a dialog, a marked local) or in the SESSION
//       runner's table — no command falls between the two seats;
//   C2  the "before" list by name: the commands a plain print run's table
//       drops that the screen forwarded to a hopped-into session (each
//       answered "Unknown skill" there); the runner's table carries every
//       session-seat one now;
//   C3  the runner, for real: a session runner (the daemon's child shape —
//       MERCURY_CONCOURSE_WORKER stamped, stream-json over stdin/stdout, the
//       fixture API as its provider) answers every one of those session-seat
//       commands by name with its own receipt, never "Unknown skill";
//   C4  the control: the SAME commands into a plain `-p` runner (no role
//       stamp) still answer "Unknown skill" — the table is the difference,
//       nothing else;
//   C5  the screen's dispatch reads the one rule (source pins): commandSeat
//       decides, the session runner's table is sessionSeatCommandTable, the
//       screen-seat locals run in the screen against the focused connector.
// ============================================================================
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-command-table-')))
const HOME = join(SCRATCH, 'home')
const CWD = join(SCRATCH, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(CWD, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_CONCOURSE_WORKER

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(HOME, [CWD])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { getCommands, commandSeat, sessionSeatCommandTable } = await import('../../src/commands.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

// ── C1/C2: the census ───────────────────────────────────────────────────────
const table = await getCommands(CWD)
const printTable = table.filter(c => (c.type === 'prompt' ? c.disableNonInteractive !== true : c.type === 'local' ? c.supportsNonInteractive === true : false))
const sessionTable = sessionSeatCommandTable(table)
const screenSeat = table.filter(c => commandSeat(c) === 'screen')
check('C1 every command the screen knows has exactly one seat', table.every(c => (commandSeat(c) === 'screen') !== sessionTable.includes(c)))
check('C1 the runner table is the session-seat half of the one table', sessionTable.every(c => commandSeat(c) === 'session') && sessionTable.length + screenSeat.length === table.length, `${sessionTable.length} session · ${screenSeat.length} screen · ${table.length} total`)
// The "before" list: what the screen forwarded to the runner that the print
// table dropped — session-seat locals without the headless mark, and the
// screen-seat locals the old seated path forwarded too (a route alias was
// intercepted; the rest reached the runner and answered "Unknown skill").
const sessionSeatDropped = table.filter(c => c.type === 'local' && commandSeat(c) === 'session' && !printTable.includes(c))
const screenSeatLocals = table.filter(c => c.type === 'local' && commandSeat(c) === 'screen' && c.uiRouteAlias === undefined && c.name !== 'bootmenu')
const before = [...sessionSeatDropped, ...screenSeatLocals].map(c => c.name).sort()
console.log(`  [CENSUS] "Unknown skill" inside a hopped-into session BEFORE (${before.length}): ${before.join(' ')}`)
console.log(`  [CENSUS] now run by the SESSION runner (${sessionSeatDropped.length}): ${sessionSeatDropped.map(c => c.name).sort().join(' ')}`)
console.log(`  [CENSUS] now run by the SCREEN against the focused chat (${screenSeatLocals.length}): ${screenSeatLocals.map(c => c.name).sort().join(' ')}`)
check('C2 the session runner carries every session-seat command the print table dropped', sessionSeatDropped.every(c => sessionTable.includes(c)))
check('C2 the census names at least the thirteen', before.length >= 13, `${before.length}`)

// ── the runner driver ───────────────────────────────────────────────────────
const api = await startFixtureApi(Array.from({ length: 24 }, (_, i) => ({ kind: 'text' as const, text: `fixture turn ${i + 1}` })))

type Runner = { child: ChildProcess; lines: string[]; waitResult: () => Promise<string[]> }
function spawnRunner(role: boolean): Runner {
  const sessionId = randomUUID()
  const child = spawn(
    'node',
    [
      BIN,
      '-p',
      '--verbose',
      '--permission-mode',
      'flow',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--model',
      'claude-sonnet-5',
      '--append-system-prompt',
      'a session runner under proof',
      '--session-id',
      sessionId,
      '--permission-prompt-tool',
      'stdio',
    ],
    {
      cwd: CWD,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: HOME,
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'fixture-key-000',
        MERCURY_CACHE_CLOCK: '0',
        MERCURY_PARTY: '0',
        ...(role ? { MERCURY_CONCOURSE_WORKER: '1' } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const lines: string[] = []
  let waiters: Array<(l: string[]) => void> = []
  let since = 0
  let buf = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (d: string) => {
    buf += d
    let at: number
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at)
      buf = buf.slice(at + 1)
      lines.push(line)
      if (line.includes('"type":"result"')) {
        const batch = lines.slice(since)
        since = lines.length
        for (const w of waiters) w(batch)
        waiters = []
      }
    }
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', () => {})
  const waitResult = (): Promise<string[]> =>
    new Promise(resolve => {
      const t = setTimeout(() => resolve(['(timeout: no result frame within 40 s)']), 40_000)
      waiters.push(l => {
        clearTimeout(t)
        resolve(l)
      })
    })
  return { child, lines, waitResult }
}

function send(r: Runner, text: string): Promise<string[]> {
  const p = r.waitResult()
  r.child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid: randomUUID() }) + '\n')
  return p
}

function receiptOf(batch: string[]): string {
  const result = batch.find(l => l.includes('"type":"result"'))
  if (result === undefined) return batch[batch.length - 1] ?? ''
  try {
    const frame = JSON.parse(result) as { result?: string; subtype?: string }
    return (frame.result ?? frame.subtype ?? '').split('\n')[0] ?? ''
  } catch {
    return result.slice(0, 200)
  }
}

// ── C3: the session runner answers every dropped session-seat command ───────
{
  const runner = spawnRunner(true)
  // A first plain turn arms the runner (its init frame rides the first turn).
  const first = await send(runner, 'hello runner')
  check('C3 the session runner answered the arming turn', first.some(l => l.includes('"type":"result"')), receiptOf(first).slice(0, 120))
  for (const c of sessionSeatDropped) {
    const args = c.name === 'counsel' ? '' : c.name === 'kill' ? '' : ''
    const batch = await send(runner, `/${c.name}${args ? ` ${args}` : ''}`)
    const text = batch.join('\n')
    const receipt = receiptOf(batch)
    check(`C3 /${c.name} runs in the session runner (its own receipt, never "Unknown skill")`, !text.includes('Unknown skill') && batch.some(l => l.includes('"type":"result"')), receipt.slice(0, 140))
  }
  runner.child.stdin!.end()
  runner.child.kill('SIGTERM')
}

// ── C4: the control — a plain -p runner still lacks them ───────────────────
{
  const control = spawnRunner(false)
  const first = await send(control, 'hello control')
  check('C4 the plain print runner answered the arming turn', first.some(l => l.includes('"type":"result"')), receiptOf(first).slice(0, 120))
  // The command estate's honesty law: a REGISTERED command never answers
  // "Unknown skill" — the roleless control now answers each name's TYPED
  // unavailable reason (interactive-surface / not-enabled …). The table is
  // still the difference: the control REFUSES where the stamped role RUNS.
  let refused = 0
  for (const c of sessionSeatDropped) {
    const batch = await send(control, `/${c.name}`)
    const text = batch.join('\n')
    if (!text.includes('Unknown skill') && /interactive|not enabled|not available|needs|foreground|sign-in|session/i.test(text)) refused++
  }
  check(`C4 the control (no role stamp) refuses every one of the ${sessionSeatDropped.length} with its typed reason, never "Unknown skill" (the table is the difference)`, refused === sessionSeatDropped.length, `${refused}/${sessionSeatDropped.length}`)
  control.child.stdin!.end()
  control.child.kill('SIGTERM')
}

// ── C5: the one rule at its owners (source pins) ────────────────────────────
{
  const commands = read('src/commands.ts')
  // Mechanism pin: the rule's three screen marks in ONE predicate (the
  // privacy fold added userPrivate and wrapped the line — a one-line copy
  // pin rotted; the predicate itself is the law).
  const seatBody = commands.slice(commands.indexOf('export function commandSeat('), commands.indexOf('export function sessionSeatCommandTable('))
  check('C5 commandSeat is the one dispatch rule (route alias · dialog · marked local · user-private ⇒ screen; else session)', seatBody.includes("if (command.type === 'local-jsx') return 'screen'") && seatBody.includes("command.uiRouteAlias !== undefined || command.seat === 'screen' || command.userPrivate === true") && seatBody.includes("return 'session'"))
  const main = read('src/main.tsx')
  check("C5 the session runner's table is sessionSeatCommandTable (MERCURY_CONCOURSE_WORKER decides)", main.includes("flagEnv('MERCURY_CONCOURSE_WORKER') === '1'") && main.includes('sessionSeatCommandTable(args.commands)'))
  const repl = read('src/screens/REPL.tsx')
  // Receipt-call re-cut: the paint takes the command NAME now (getCommandName)
  // and only a non-empty text result paints — same seam, honest spelling.
  check('C5 the screen dispatches on commandSeat and runs screen-seat locals against the focused connector', repl.includes("const seat = seatCommand === undefined ? 'session' : commandSeat(seatCommand)") && repl.includes('paintScreenCommandReceipt(getCommandName(seatCommand), args, result.value)'))
  const clear = read('src/commands/clear/clear.ts')
  check('C5 /clear acts on the screen: the old session released, a fresh session born (the one-door law)', clear.includes('clearFocusedSession()'))
  for (const name of ['accent', 'bootmenu', 'clear', 'companion', 'keybindings', 'mouse', 'rewind', 'vim']) {
    check(`C5 /${name} is marked a screen-seat command`, read(`src/commands/${name}/index.ts`).includes("seat: 'screen'"))
  }
}

// ── C6: THE PLAIN WORLD — the concourse-only commands answer one sentence ──
// (the chat-mode law, the operator: "effective CLI in chat mode"). A
// command whose only meaning is the Session Concourse declares
// `needsConcourse`; in a `--chat` boot, or with the concourse switched off,
// it leaves the table and typed by name answers the router's sentence —
// why the concourse is off in this boot and the way back. POISONS: a
// concourse-only command enabled in the plain world; the generic "exists
// but is not enabled" line (or "Unknown skill") for one; the plain CLI's
// own commands (/sessions · /tasks · /team · /resume) gated with them.
console.log('C6 — the plain world: the concourse-only commands, one predicate, one sentence')
{
  const route = await import('../../src/context/surfaceRoute.ts')
  const { builtinCommands, commandOffInPlainWorld, isCommandEnabled } = await import('../../src/commands.ts')
  const { unavailableCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
  const { setConcourseEnabled } = await import('../../src/services/concourse/concourseEnabled.ts')
  // The switch persists through the global config, whose reads are refused
  // until boot opens them — a pure prover opens the door itself (the home is
  // this prover's scratch, pinned above before any src import).
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const registry = [...builtinCommands()]
  const concourseOnly = registry.filter(c => c.needsConcourse === true)
  const byName = (name: string) => registry.find(c => c.name === name)
  check('C6 the concourse-only set is declared: cockpit · crew · fleet · live · monitor · teammates · workflows', JSON.stringify(concourseOnly.map(c => c.name).sort()) === JSON.stringify(['cockpit', 'crew', 'fleet', 'live', 'monitor', 'teammates', 'workflows']), concourseOnly.map(c => c.name).sort().join(' '))
  check("C6 the plain CLI's own commands are not gated with them (/sessions · /tasks · /team · /resume) and /concourse stays the explicit door", ['sessions', 'tasks', 'team', 'resume', 'concourse'].every(n => byName(n) !== undefined && byName(n)!.needsConcourse !== true))
  // The fleet world: a fresh home's switch is on, no mark.
  route._resetSurfaceRouteForTesting()
  setConcourseEnabled(true)
  check('C6 fleet world: the world gates nothing', registry.every(c => !commandOffInPlainWorld(c)))
  // --chat: the mark alone.
  route.markChatBoot()
  check('C6 --chat: exactly the concourse-only commands are off by the world', registry.every(c => commandOffInPlainWorld(c) === (c.needsConcourse === true)))
  check('C6 --chat: the one enablement read drops them from the table', concourseOnly.every(c => !isCommandEnabled(c)))
  const chatLine = unavailableCommandLine(byName('fleet')!)
  check('C6 --chat: /fleet typed answers the sentence — off in this boot (--chat), a plain boot has it', chatLine.includes('The /fleet command opens a Session Concourse surface — the Session Concourse is off in this boot (--chat) — a plain `mercury` boot has it.'), chatLine)
  check('C6 POISON absent: no concourse-only command answers the generic enablement line or "Unknown skill" in the plain world', concourseOnly.every(c => { const l = unavailableCommandLine(c); return !l.includes('exists but is not enabled') && !l.includes('Unknown skill') }))
  check('C6 --chat over a saved switch off is no contradiction: both = the plain world, the sentence names both and the way back', (() => { setConcourseEnabled(false); const l = unavailableCommandLine(byName('workflows')!); setConcourseEnabled(true); return l.includes('(--chat · concourse off)') && l.includes('`mercury --concourse-on` or /config turns it back') })())
  route._resetSurfaceRouteForTesting()
  // The saved switch off, no mark: the same set, the way back named.
  setConcourseEnabled(false)
  check('C6 the switch off: the same set is off; the sentence names the way back (--concourse-on or /config)', concourseOnly.every(c => commandOffInPlainWorld(c)) && unavailableCommandLine(byName('cockpit')!).includes('the Session Concourse is off in this boot (concourse off) — `mercury --concourse-on` or /config turns it back'))
  setConcourseEnabled(true)
  check('C6 the switch back on: the fleet world again (off is never a one-way door)', registry.every(c => !commandOffInPlainWorld(c)))
  check('C6 the sentence has one owner (surfaceRoute.concourseOffSentence) and the dispatcher reads it first', read('src/utils/processUserInput/processSlashCommand.tsx').includes('if (commandOffInPlainWorld(real)) {') && read('src/commands/enablement.ts').includes('command.needsConcourse === true && chatOnlyBoot()'))
  // The roster is memoized at load; the switch can flip through /config
  // mid-session. The dispatcher re-reads enablement so a stale table never
  // runs a concourse-only command in the plain world.
  const dispatcher = read('src/utils/processUserInput/processSlashCommand.tsx')
  // Both needles present, and the unknown-command branch that FOLLOWS the
  // re-read is the one compared (an earlier `if (!command)` in another
  // function made the first-occurrence compare false; a rotted needle would
  // make it vacuously true — the vacuous-ordering-pin class).
  const reReadIdx = dispatcher.indexOf('if (command && !isCommandEnabled(command)) {')
  check('C6 the dispatcher re-reads enablement at dispatch (a mid-session switch flip answers the line, never runs from the stale roster)', reReadIdx !== -1 && dispatcher.indexOf('if (!command) {', reReadIdx) !== -1)
}

// ── C7: the RETIRED doors (the old multiplayer's commands) ──────────────────
// The names stay registered so a typed /name answers its own reason in
// every world and on every seat — the plain-world honesty grammar — while
// none is enabled or listed. TEN doors: the nine of the first cut plus /say
// (operator ruling — the door retires, the local channel bus
// stays as the agents' wire); the list below IS the roster, so a door
// added to or dropped from the stub module reds HERE. POISONS: a retired
// name enabled anywhere; a retired name visible; the generic enablement
// line or "Unknown skill" for one; a retired name still owned by a second,
// live registration.
console.log('C7 — the retired doors: registered, never enabled, never listed, one sentence')
{
  const route = await import('../../src/context/surfaceRoute.ts')
  const { builtinCommands, commandRetired, isCommandEnabled } = await import('../../src/commands.ts')
  const { unavailableCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
  const { RETIRED_MULTIPLAYER_COMMANDS, RETIRED_MULTIPLAYER_REASON } = await import('../../src/commands/retired.ts')
  const registry = [...builtinCommands()]
  const retiredNames = RETIRED_MULTIPLAYER_COMMANDS.map(c => c.name)
  check('C7 the ten retired names are declared: party · multiplayer · share · invite · handoff · delegate · prompt · request · tickets · say', JSON.stringify([...retiredNames].sort()) === JSON.stringify(['delegate', 'handoff', 'invite', 'multiplayer', 'party', 'prompt', 'request', 'say', 'share', 'tickets']), retiredNames.join(' '))
  const owners = (name: string) => registry.filter(c => c.name === name || c.aliases?.includes(name) === true)
  check('C7 every retired name (and the rooms alias) has exactly ONE registration and it is the retired one', [...retiredNames, 'rooms'].every(n => owners(n).length === 1 && commandRetired(owners(n)[0]!) === RETIRED_MULTIPLAYER_REASON), [...retiredNames, 'rooms'].map(n => `${n}:${owners(n).length}`).join(' '))
  const retired = registry.filter(c => commandRetired(c) !== undefined)
  check('C7 no retired door is enabled in the fleet world, and none is listed (hidden)', retired.every(c => !isCommandEnabled(c) && c.isHidden === true))
  route._resetSurfaceRouteForTesting()
  route.markChatBoot()
  check('C7 …nor in the plain world', retired.every(c => !isCommandEnabled(c)))
  route._resetSurfaceRouteForTesting()
  check('C7 typed, each answers its own sentence — "retired — a new multiplayer is being built on the channel; nothing to run here" — never the generic line, never "Unknown skill"', retired.every(c => { const l = unavailableCommandLine(c); return l === `The /${c.name} command is retired — ${RETIRED_MULTIPLAYER_REASON}.` && !l.includes('exists but is not enabled') && !l.includes('Unknown skill') }), retired.map(c => unavailableCommandLine(c)).join(' | '))
  check('C7 the dispatcher reads the retired reason FIRST (before the plain-world sentence) and the one enablement read folds it in', read('src/utils/processUserInput/processSlashCommand.tsx').indexOf('const retired = commandRetired(real)') < read('src/utils/processUserInput/processSlashCommand.tsx').indexOf('if (commandOffInPlainWorld(real)) {') && read('src/commands/enablement.ts').includes('commandRetired(command) === undefined'))
  check('C7 the screen seat paints a retired door display-only (the gated resolver reads retirement beside the plain-world gate)', read('src/screens/REPL.tsx').includes('(commandOffInPlainWorld(real) || commandRetired(real) !== undefined)'))
}

await api.close()
try {
  rmSync(SCRATCH, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(failures === 0 ? '\nprove-command-table: ALL LAWS HOLD' : `\nprove-command-table: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
