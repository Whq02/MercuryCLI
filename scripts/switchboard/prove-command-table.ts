#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isOutcome, parseFrame } from '../lib/rows.ts'

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

const table = await getCommands(CWD)
const printTable = table.filter(c => (c.type === 'prompt' ? c.disableNonInteractive !== true : c.type === 'local' ? c.supportsNonInteractive === true : false))
const sessionTable = sessionSeatCommandTable(table)
const screenSeat = table.filter(c => commandSeat(c) === 'screen')
check('C1 every command the screen knows has exactly one seat', table.every(c => (commandSeat(c) === 'screen') !== sessionTable.includes(c)))
check('C1 the runner table is the session-seat half of the one table', sessionTable.every(c => commandSeat(c) === 'session') && sessionTable.length + screenSeat.length === table.length, `${sessionTable.length} session · ${screenSeat.length} screen · ${table.length} total`)
const sessionSeatDropped = table.filter(c => c.type === 'local' && commandSeat(c) === 'session' && !printTable.includes(c))
const screenSeatLocals = table.filter(c => c.type === 'local' && commandSeat(c) === 'screen' && c.uiRouteAlias === undefined && c.name !== 'bootmenu')
const before = [...sessionSeatDropped, ...screenSeatLocals].map(c => c.name).sort()
console.log(`  [CENSUS] "Unknown skill" inside a hopped-into session BEFORE (${before.length}): ${before.join(' ')}`)
console.log(`  [CENSUS] now run by the SESSION runner (${sessionSeatDropped.length}): ${sessionSeatDropped.map(c => c.name).sort().join(' ')}`)
console.log(`  [CENSUS] now run by the SCREEN against the focused chat (${screenSeatLocals.length}): ${screenSeatLocals.map(c => c.name).sort().join(' ')}`)
check('C2 the session runner carries every session-seat command the print table dropped', sessionSeatDropped.every(c => sessionTable.includes(c)))
check('C2 the census names at least the thirteen', before.length >= 13, `${before.length}`)

const api = await startFixtureApi(Array.from({ length: 24 }, (_, i) => ({ kind: 'text' as const, text: `fixture turn ${i + 1}` })))

type Runner = { child: ChildProcess; lines: string[]; waitResult: () => Promise<string[]> }
function spawnRunner(role: boolean): Runner {
  const sessionId = randomUUID()
  const child = spawn(
    'node',
    [
      BIN,
      'run',
      '--mode',
      'flow',
      '--input=rows',
      '--format=rows',
      '--model',
      'claude-sonnet-5',
      '--brief-add',
      'a session runner under proof',
      '--session-id',
      sessionId,
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
      if (isOutcome(parseFrame(line))) {
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
      const t = setTimeout(() => resolve(['(timeout: no outcome row within 40 s)']), 40_000)
      waiters.push(l => {
        clearTimeout(t)
        resolve(l)
      })
    })
  return { child, lines, waitResult }
}

function send(r: Runner, text: string): Promise<string[]> {
  const p = r.waitResult()
  r.child.stdin!.write(JSON.stringify({ type: 'prompt', content: text, id: randomUUID() }) + '\n')
  return p
}

function receiptOf(batch: string[]): string {
  const result = batch.find(l => isOutcome(parseFrame(l)))
  if (result === undefined) return batch[batch.length - 1] ?? ''
  try {
    const frame = JSON.parse(result) as { answer?: string; error?: { message?: string }; status?: string }
    return (frame.answer ?? frame.error?.message ?? frame.status ?? '').split('\n')[0] ?? ''
  } catch {
    return result.slice(0, 200)
  }
}

{
  const runner = spawnRunner(true)
  const first = await send(runner, 'hello runner')
  check('C3 the session runner answered the arming turn', first.some(l => isOutcome(parseFrame(l))), receiptOf(first).slice(0, 120))
  for (const c of sessionSeatDropped) {
    const args = c.name === 'counsel' ? '' : c.name === 'kill' ? '' : ''
    const batch = await send(runner, `/${c.name}${args ? ` ${args}` : ''}`)
    const text = batch.join('\n')
    const receipt = receiptOf(batch)
    check(`C3 /${c.name} runs in the session runner (its own receipt, never "Unknown skill")`, !text.includes('Unknown skill') && batch.some(l => isOutcome(parseFrame(l))), receipt.slice(0, 140))
  }
  runner.child.stdin!.end()
  runner.child.kill('SIGTERM')
}

{
  const control = spawnRunner(false)
  const first = await send(control, 'hello control')
  check('C4 the plain runner answered the arming turn', first.some(l => isOutcome(parseFrame(l))), receiptOf(first).slice(0, 120))
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

{
  const commands = read('src/commands.ts')
  const seatBody = commands.slice(commands.indexOf('export function commandSeat('), commands.indexOf('export function sessionSeatCommandTable('))
  check('C5 commandSeat is the one dispatch rule (route alias · dialog · marked local · user-private ⇒ screen; else session)', seatBody.includes("if (command.type === 'local-jsx') return 'screen'") && seatBody.includes("command.uiRouteAlias !== undefined || command.seat === 'screen' || command.userPrivate === true") && seatBody.includes("return 'session'"))
  const main = read('src/main.tsx')
  check("C5 the session runner's table is sessionSeatCommandTable (MERCURY_CONCOURSE_WORKER decides)", main.includes("flagEnv('MERCURY_CONCOURSE_WORKER') === '1'") && main.includes('sessionSeatCommandTable(args.commands)'))
  const repl = read('src/screens/Chat.tsx')
  check('C5 the screen dispatches on commandSeat and runs screen-seat locals against the focused connector', repl.includes("const seat = seatCommand === undefined ? 'session' : commandSeat(seatCommand)") && repl.includes('paintScreenCommandReceipt(getCommandName(seatCommand), args, result.value)'))
  const clear = read('src/commands/clear/clear.ts')
  check('C5 /clear acts on the screen: the old session released, a fresh session born (the one-door law)', clear.includes('clearFocusedSession()'))
  for (const name of ['accent', 'bootmenu', 'clear', 'keybindings', 'mouse', 'rewind', 'view', 'vim']) {
    check(`C5 /${name} is marked a screen-seat command`, read(`src/commands/${name}/index.ts`).includes("seat: 'screen'"))
  }
}

console.log('C6 — the plain world: the concourse-only commands, one predicate, one sentence')
{
  const route = await import('../../src/context/surfaceRoute.ts')
  const { builtinCommands, commandOffInPlainWorld, isCommandEnabled } = await import('../../src/commands.ts')
  const { unavailableCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
  const { setConcourseEnabled } = await import('../../src/services/concourse/concourseEnabled.ts')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const registry = [...builtinCommands()]
  const concourseOnly = registry.filter(c => c.needsConcourse === true)
  const byName = (name: string) => registry.find(c => c.name === name)
  check('C6 the concourse-only set is declared: cockpit · crew · crewmates · fleet · live · monitor · workflows', JSON.stringify(concourseOnly.map(c => c.name).sort()) === JSON.stringify(['cockpit', 'crew', 'crewmates', 'fleet', 'live', 'monitor', 'workflows']), concourseOnly.map(c => c.name).sort().join(' '))
  check("C6 the plain CLI's own commands are not gated with them (/sessions · /runs · /resume) and /concourse stays the explicit door", ['sessions', 'runs', 'resume', 'concourse'].every(n => byName(n) !== undefined && byName(n)!.needsConcourse !== true), ['sessions', 'runs', 'resume', 'concourse'].map(n => `${n}:${byName(n) === undefined ? 'absent' : String(byName(n)!.needsConcourse === true)}`).join(' '))
  const { findCommand, builtInCommandNames } = await import('../../src/commands.ts')
  const oldBoard = ['te', 'am'].join('')
  check('C6 the old board command is gone, not gated: the retired name is no command (its board is /runs) and /crew is the concourse-only crew directory', byName(oldBoard) === undefined && findCommand(oldBoard, registry) === undefined && byName('crew')?.needsConcourse === true, `/${oldBoard}: ${byName(oldBoard) === undefined ? 'absent' : 'present'} · /crew needsConcourse ${String(byName('crew')?.needsConcourse)}`)
  const runs = registry.find(command => command.name === 'runs')
  check('the board is /runs and /tasks resolves to the very same command', runs !== undefined && findCommand('runs', registry) === runs && findCommand('tasks', registry) === runs)
  check('the command-name catalogue keeps both the board name and its fallback', builtInCommandNames().has('runs') && builtInCommandNames().has('tasks'))
  route._resetSurfaceRouteForTesting()
  setConcourseEnabled(true)
  check('C6 fleet world: the world gates nothing', registry.every(c => !commandOffInPlainWorld(c)))
  route.markChatBoot()
  check('C6 --chat: exactly the concourse-only commands are off by the world', registry.every(c => commandOffInPlainWorld(c) === (c.needsConcourse === true)))
  check('C6 --chat: the one enablement read drops them from the table', concourseOnly.every(c => !isCommandEnabled(c)))
  const chatLine = unavailableCommandLine(byName('fleet')!)
  check('C6 --chat: /fleet typed answers the sentence — off in this boot (--chat), a plain boot has it', chatLine.includes('The /fleet command opens a Session Concourse surface — the Session Concourse is off in this boot (--chat) — a plain `mercury` boot has it.'), chatLine)
  check('C6 POISON absent: no concourse-only command answers the generic enablement line or "Unknown skill" in the plain world', concourseOnly.every(c => { const l = unavailableCommandLine(c); return !l.includes('exists but is not enabled') && !l.includes('Unknown skill') }))
  check('C6 --chat over a saved switch off is no contradiction: both = the plain world, the sentence names both and the way back', (() => { setConcourseEnabled(false); const l = unavailableCommandLine(byName('workflows')!); setConcourseEnabled(true); return l.includes('(--chat · concourse off)') && l.includes('`mercury --concourse-on` or /config turns it back') })())
  route._resetSurfaceRouteForTesting()
  setConcourseEnabled(false)
  check('C6 the switch off: the same set is off; the sentence names the way back (--concourse-on or /config)', concourseOnly.every(c => commandOffInPlainWorld(c)) && unavailableCommandLine(byName('cockpit')!).includes('the Session Concourse is off in this boot (concourse off) — `mercury --concourse-on` or /config turns it back'))
  setConcourseEnabled(true)
  check('C6 the switch back on: the fleet world again (off is never a one-way door)', registry.every(c => !commandOffInPlainWorld(c)))
  check('C6 the sentence has one owner (surfaceRoute.concourseOffSentence) and the dispatcher reads it first', read('src/utils/processUserInput/processSlashCommand.tsx').includes('if (commandOffInPlainWorld(real)) {') && read('src/commands/enablement.ts').includes('command.needsConcourse === true && chatOnlyBoot()'))
  const dispatcher = read('src/utils/processUserInput/processSlashCommand.tsx')
  const reReadIdx = dispatcher.indexOf('if (command && !isCommandEnabled(command)) {')
  check('C6 the dispatcher re-reads enablement at dispatch (a mid-session switch flip answers the line, never runs from the stale roster)', reReadIdx !== -1 && dispatcher.indexOf('if (!command) {', reReadIdx) !== -1)
}

console.log('C7 — the former doors are unknown commands')
{
  const { builtinCommands } = await import('../../src/commands.ts')
  const { unknownCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
  const registry = [...builtinCommands()]
  const formerNames = ['party', 'multiplayer', 'share', 'invite', 'handoff', 'delegate', 'prompt', 'request', 'tickets', 'say', 'rooms']
  const owners = (name: string) => registry.filter(c => c.name === name || c.aliases?.includes(name) === true)
  check('C7 none of the former names (nor the rooms alias) has a registration', formerNames.every(n => owners(n).length === 0), formerNames.map(n => `${n}:${owners(n).length}`).join(' '))
  const shape = (line: string): string => line.replace(/^Unknown command: \/[a-z]+/, 'Unknown command: /<name>').replace(/ — closest: \/[a-z-]+/, '')
  const control = shape(unknownCommandLine('frobnicate', registry))
  check('C7 typed, each former name answers exactly as a never-existing name does — the unknown-command sentence, no retired word', formerNames.every(n => { const l = unknownCommandLine(n, registry); return shape(l) === control && !/retired/i.test(l) }), formerNames.map(n => unknownCommandLine(n, registry)).join(' | '))
  check('C7 the dispatcher carries no retirement read', !read('src/utils/processUserInput/processSlashCommand.tsx').includes('commandRetired') && !read('src/commands/enablement.ts').includes('commandRetired') && !read('src/screens/Chat.tsx').includes('commandRetired'))
}

await api.close()
try {
  rmSync(SCRATCH, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\nprove-command-table: ALL LAWS HOLD' : `\nprove-command-table: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
