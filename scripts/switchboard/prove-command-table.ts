#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isOutcome, parseFrame } from '../lib/rows.ts'
import { removeScratch } from '../lib/removeScratch.ts'

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
const { getCommands, commandSeat, sessionSeatCommandTable } = await import('../../src/commands/catalogue/commands.ts')

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}

const table = await getCommands(CWD)
const printTable = table.filter(c => (c.type === 'prompt' ? c.disableNonInteractive !== true : c.type === 'local' ? c.supportsNonInteractive === true : false))
const sessionTable = sessionSeatCommandTable(table)
const swarmchat = table.find(c => c.name === 'swarmchat')
check('C1 /swarmchat advertises only the toggle, explicit switches and existing filters', swarmchat?.argumentHint === '[on|off|all|team <name>|main]' && swarmchat.description === 'Show board messages in the chat', '', 'set argumentHint and description in src/commands/swarmchat/index.ts')
check('C1 /swarmchat carries every grammar arm into the session runner', swarmchat?.type === 'local-jsx' && JSON.stringify(swarmchat.headlessVerbs) === JSON.stringify(['', 'on', 'off', 'all', 'team', 'main']) && sessionTable.includes(swarmchat), '', 'declare headlessVerbs on the command in src/commands/swarmchat/index.ts and check sessionSeatCommandTable in src/commands/catalogue/commands.ts')
const screenSeat = table.filter(c => commandSeat(c) === 'screen')
const hasHeadlessForm = (c: typeof table[number]): boolean => c.type === 'local-jsx' && (c.headlessVerbs?.length ?? 0) > 0
check('C1 screen-only commands stay out of the runner; declared headless forms have a runner road', table.every(c => sessionTable.includes(c) === (commandSeat(c) === 'session' || hasHeadlessForm(c))), '', 'sessionSeatCommandTable and commandSeat in src/commands/catalogue/commands.ts must keep screen-only commands out of the runner table and admit session-seat commands and declared headless forms')
check('C1 the runner table adds only declared headless forms of screen commands', sessionTable.every(c => commandSeat(c) === 'session' || hasHeadlessForm(c)) && sessionTable.length + screenSeat.filter(c => !hasHeadlessForm(c)).length === table.length, `${sessionTable.length} runner · ${screenSeat.length} screen · ${table.length} total`, 'sessionSeatCommandTable in src/commands/catalogue/commands.ts must add only session-seat commands and declared headless forms')
const sessionSeatDropped = table.filter(c => c.type === 'local' && commandSeat(c) === 'session' && !printTable.includes(c))
const screenSeatLocals = table.filter(c => c.type === 'local' && commandSeat(c) === 'screen' && c.uiRouteAlias === undefined && c.name !== 'bootmenu')
const before = [...sessionSeatDropped, ...screenSeatLocals].map(c => c.name).sort()
console.log(`  [CENSUS] "Unknown skill" inside a hopped-into session BEFORE (${before.length}): ${before.join(' ')}`)
console.log(`  [CENSUS] now run by the SESSION runner (${sessionSeatDropped.length}): ${sessionSeatDropped.map(c => c.name).sort().join(' ')}`)
console.log(`  [CENSUS] now run by the SCREEN against the focused chat (${screenSeatLocals.length}): ${screenSeatLocals.map(c => c.name).sort().join(' ')}`)
check('C2 the session runner carries every session-seat command the print table dropped', sessionSeatDropped.every(c => sessionTable.includes(c)), '', 'sessionSeatCommandTable in src/commands/catalogue/commands.ts must include every session-seat command the print table dropped')
check('C2 the census names at least the thirteen', before.length >= 13, `${before.length}`, 'commandSeat in src/commands/catalogue/commands.ts classifies fewer commands as session or screen locals than the census expects')

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
  check('C3 the session runner answered the arming turn', first.some(l => isOutcome(parseFrame(l))), receiptOf(first).slice(0, 120), 'the runner started with node dist/mercury.mjs run (rebuild with bun run build.ts) gave no outcome row; run it by hand with MERCURY_CONCOURSE_WORKER=1')
  for (const c of sessionSeatDropped) {
    const args = ''
    const batch = await send(runner, `/${c.name}${args ? ` ${args}` : ''}`)
    const text = batch.join('\n')
    const receipt = receiptOf(batch)
    check(`C3 /${c.name} runs in the session runner (its own receipt, never "Unknown skill")`, !text.includes('Unknown skill') && batch.some(l => isOutcome(parseFrame(l))), receipt.slice(0, 140), 'the command must be in the table sessionSeatCommandTable (src/commands/catalogue/commands.ts) hands the runner')
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
  check(`C4 the control (no role stamp) refuses every one of the ${sessionSeatDropped.length} with its typed reason, never "Unknown skill" (the table is the difference)`, refused === sessionSeatDropped.length, `${refused}/${sessionSeatDropped.length}`, 'the plain runner must answer a session-seat command with its typed refusal; see unavailableCommandLine in src/engine/user-input/processSlashCommand.tsx')
  control.child.stdin!.end()
  control.child.kill('SIGTERM')
}


console.log('C6 — the plain world: the concourse-only commands, one predicate, one sentence')
{
  const route = await import('../../src/screen/routes/surfaceRoute.ts')
  const { builtinCommands, commandOffInPlainWorld, isCommandEnabled } = await import('../../src/commands/catalogue/commands.ts')
  const { unavailableCommandLine } = await import('../../src/engine/user-input/processSlashCommand.tsx')
  const { setConcourseEnabled } = await import('../../src/screen/concourse-model/concourseEnabled.ts')
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const registry = [...builtinCommands()]
  const concourseOnly = registry.filter(c => c.needsConcourse === true)
  const byName = (name: string) => registry.find(c => c.name === name)
  check('C6 the concourse-only set is declared: crew · crewmates', JSON.stringify(concourseOnly.map(c => c.name).sort()) === JSON.stringify(['crew', 'crewmates']), concourseOnly.map(c => c.name).sort().join(' '), 'set needsConcourse on exactly crew and crewmates in their command files under src/commands')
  check("C6 the plain CLI's own commands are not gated with them (/sessions · /runs) and /concourse stays the explicit door", ['sessions', 'runs', 'concourse'].every(n => byName(n) !== undefined && byName(n)!.needsConcourse !== true), ['sessions', 'runs', 'concourse'].map(n => `${n}:${byName(n) === undefined ? 'absent' : String(byName(n)!.needsConcourse === true)}`).join(' '), 'needsConcourse must stay unset on sessions, runs and concourse in their command files under src/commands')
  const { findCommand, builtInCommandNames } = await import('../../src/commands/catalogue/commands.ts')
  const team = byName('team')
  check('C6 /team is the directed board channel, a local screen command that is not concourse-gated (the old board under that name is /runs) and /crew is the concourse-only crew directory', team !== undefined && team.type === 'local' && team.seat === 'screen' && team.needsConcourse !== true && findCommand('team', registry) === team && byName('crew')?.needsConcourse === true, `/team: ${team === undefined ? 'absent' : `${team.type} seat ${String(team.seat)} needsConcourse ${String(team.needsConcourse)}`} · /crew needsConcourse ${String(byName('crew')?.needsConcourse)}`, 'check the team and crew commands under src/commands')
  const runs = registry.find(command => command.name === 'runs')
  check('the board is /runs and /tasks resolves to the very same command', runs !== undefined && findCommand('runs', registry) === runs && findCommand('tasks', registry) === runs, '', 'the runs command under src/commands must keep tasks as its alias, resolved by findCommand in src/commands/catalogue/commands.ts')
  check('the command-name catalogue keeps both the board name and its fallback', builtInCommandNames().has('runs') && builtInCommandNames().has('tasks'), '', 'builtInCommandNames in src/commands/catalogue/commands.ts must list runs and tasks')
  route._resetSurfaceRouteForTesting()
  setConcourseEnabled(true)
  check('C6 fleet world: the world gates nothing', registry.every(c => !commandOffInPlainWorld(c)), '', 'commandOffInPlainWorld in src/commands/catalogue/enablement.ts must gate nothing while the concourse is enabled')
  route.markChatBoot()
  check('C6 --chat: exactly the concourse-only commands are off by the world', registry.every(c => commandOffInPlainWorld(c) === (c.needsConcourse === true)), '', 'commandOffInPlainWorld in src/commands/catalogue/enablement.ts must be true exactly for needsConcourse commands under --chat')
  check('C6 --chat: the one enablement read drops them from the table', concourseOnly.every(c => !isCommandEnabled(c)), '', 'isCommandEnabled in src/commands/catalogue/enablement.ts must drop needsConcourse commands in the plain world')
  const chatLine = unavailableCommandLine(byName('crewmates')!)
  check('C6 --chat: /crewmates typed answers the sentence — off in this boot (--chat), a plain boot has it', chatLine.includes('The /crewmates command opens a Session Concourse surface — the Session Concourse is off in this boot (--chat) — a plain `mercury` boot has it.'), chatLine, 'unavailableCommandLine in src/engine/user-input/processSlashCommand.tsx must give this sentence for a concourse-only command')
  check('C6 POISON absent: no concourse-only command answers the generic enablement line or "Unknown skill" in the plain world', concourseOnly.every(c => { const l = unavailableCommandLine(c); return !l.includes('exists but is not enabled') && !l.includes('Unknown skill') }), '', 'unavailableCommandLine in src/engine/user-input/processSlashCommand.tsx must not use the generic enablement line or Unknown skill for these')
  check('C6 --chat over a saved switch off is no contradiction: both = the plain world, the sentence names both and the way back', (() => { setConcourseEnabled(false); const l = unavailableCommandLine(byName('crewmates')!); setConcourseEnabled(true); return l.includes('(--chat · concourse off)') && l.includes('`mercury --concourse-on` or /config turns it back') })())
  route._resetSurfaceRouteForTesting()
  setConcourseEnabled(false)
  check('C6 the switch off: the same set is off; the sentence names the way back (--concourse-on or /config)', concourseOnly.every(c => commandOffInPlainWorld(c)) && unavailableCommandLine(byName('crewmates')!).includes('the Session Concourse is off in this boot (concourse off) — `mercury --concourse-on` or /config turns it back'))
  setConcourseEnabled(true)
  check('C6 the switch back on: the fleet world again (off is never a one-way door)', registry.every(c => !commandOffInPlainWorld(c)))
}

console.log('C7 — the former doors are unknown commands')
{
  const { builtinCommands } = await import('../../src/commands/catalogue/commands.ts')
  const { unknownCommandLine } = await import('../../src/engine/user-input/processSlashCommand.tsx')
  const registry = [...builtinCommands()]
  const formerNames = ['party', 'multiplayer', 'share', 'invite', 'handoff', 'delegate', 'prompt', 'request', 'tickets', 'say', 'rooms']
  const owners = (name: string) => registry.filter(c => c.name === name || c.aliases?.includes(name) === true)
  check('C7 none of the former names (nor the rooms alias) has a registration', formerNames.every(n => owners(n).length === 0), formerNames.map(n => `${n}:${owners(n).length}`).join(' '), 'remove the registration or alias of each listed name under src/commands')
  const shape = (line: string): string => line.replace(/^Unknown command: \/[a-z]+/, 'Unknown command: /<name>').replace(/ — closest: \/[a-z-]+/, '')
  const control = shape(unknownCommandLine('frobnicate', registry))
  check('C7 typed, each former name answers exactly as a never-existing name does — the unknown-command sentence, no retired word', formerNames.every(n => { const l = unknownCommandLine(n, registry); return shape(l) === control && !/retired/i.test(l) }), formerNames.map(n => unknownCommandLine(n, registry)).join(' | '), 'unknownCommandLine in src/engine/user-input/processSlashCommand.tsx must answer these exactly as it answers a never-existing name')
}

await api.close()
try {
  removeScratch(SCRATCH)
} catch {
}
console.log(failures === 0 ? '\nprove-command-table: ALL LAWS HOLD' : `\nprove-command-table: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
