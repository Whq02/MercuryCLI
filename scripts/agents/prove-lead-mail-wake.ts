#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const bundle = arg('--bundle')
const dist = bundle !== undefined ? realpathSync(bundle) : join(root, 'dist/mercury.mjs')
if (!existsSync(dist)) throw new Error('Build the product before running this check')
const vendoredNode = join(root, 'dist/vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const node = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const world = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'lead-mail-wake-'))
const config = join(world, 'config')
const project = join(world, 'project')
const teams = join(world, 'teams')
mkdirSync(project)
seedFirstRun(config, [project])
process.env.MERCURY_CONFIG_DIR = config
process.env.MERCURY_TEAMS_DIR = teams
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const WAKE_WINDOW_MS = 8_000
const model = 'claude-fable-5-1'
const teammateModel = 'claude-opus-4-6'
const sessionId = randomUUID()
const team = sessionId
const lead = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model, whenModel: 'fable-5-1' } as ScriptedTurn)
const water = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: teammateModel, whenModel: 'opus-4-6' } as ScriptedTurn)
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: 'water', team_name: 'crew', model: teammateModel, subagent_type: 'mercury-general', description: 'Water report', prompt: 'Send READY-WATER to team-lead once, after a pause.' } }),
  lead({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 120', run_in_background: true, description: 'A pool that outlives the window' } }),
  lead({ kind: 'text', text: 'LEAD-PARKED' }),
  lead({ kind: 'paced_tool_use', whenBody: 'MIDTURN-CHECK', preDeltas: ['Working', '.', '.'], gapMs: 1000, tools: [{ name: 'Bash', input: { command: 'pwd', description: 'Reach a tool boundary' } }] }),
  ...Array.from({ length: 12 }, (_, i) => lead({ kind: 'text', text: 'LEAD-ACK-' + i })),
  water({ kind: 'paced_tool_use', preDeltas: ['Working', '.', '.', '.'], gapMs: 2000, tools: [{ name: 'SendMessage', input: { to: 'team-lead', message: 'READY-WATER', summary: 'READY-WATER' } }] }),
  water({ kind: 'text', text: 'Water done.' }),
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const fixture = await startFixtureApi(script)
const child = spawn(node, [dist, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--permission-mode', 'sovereign', '--allowed-tools', 'Agent', 'SendMessage', 'Bash', '--session-id', sessionId], {
  cwd: project,
  env: { HOME: world, PATH: '/usr/bin:/bin:' + dirname(node), TERM: 'dumb', MERCURY_CONFIG_DIR: config, MERCURY_TEAMS_DIR: teams, MERCURY_DAEMON_DIR: join(world, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: fixture.url },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', data => { stdout += data })
child.stderr.on('data', data => { stderr += data })
let exited = false
const exit = new Promise<void>(resolveExit => child.on('close', () => { exited = true; resolveExit() }))
async function waitFor(predicate: () => boolean, label: string, limitMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + limitMs
  while (!predicate()) {
    if (exited) throw new Error(`${label}: the lead exited\n${stdout.slice(-800)}\n${stderr.slice(-800)}`)
    if (Date.now() >= deadline) return false
    await new Promise(resolveTick => setTimeout(resolveTick, 20))
  }
  return true
}
const submit = (text: string) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
const inboxPath = join(config, 'crew', 'livecomms', `${team}.json`)
type Row = { to?: string; text: string; read?: boolean; from: string; timestamp: string; delivery?: { id: string } }
const readInbox = (): Row[] | null => {
  if (!existsSync(inboxPath)) return null
  try {
    const file = JSON.parse(readFileSync(inboxPath, 'utf8')) as { messages?: Row[] }
    return (file.messages ?? []).filter(row => row.to === 'team-lead')
  } catch {
    return null
  }
}
type Request = { body: { model?: string; messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> } }
const textOf = (message: { content: string | Array<{ type: string; text?: string }> }): string =>
  typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
const leadRequests = (): Request[] => (fixture.messageRequests() as Request[]).filter(request => request.body.model === model)
const openingOf = (request: Request): string => {
  const users = (request.body.messages ?? []).filter(message => message.role === 'user')
  const last = users[users.length - 1]
  return last === undefined ? '' : textOf(last)
}
const turnOpenedWith = (needle: string): Request | undefined =>
  leadRequests().find(request => openingOf(request).includes(needle) && openingOf(request).trimStart().startsWith('<teammate-message'))
const blocksIn = (request: Request | undefined, needle: string): number => {
  if (request === undefined) return 0
  return (request.body.messages ?? []).filter(message => message.role === 'user').flatMap(message => [...textOf(message).matchAll(/<teammate-message\b[^>]*>([\s\S]*?)<\/teammate-message>/g)].map(match => match[1]!)).filter(text => text.includes(needle)).length
}

console.log(`lead mail wake: world ${world} · bundle ${dist}`)
try {
  submit('START: spawn water, start the pool, then park.')
  const parked = await waitFor(() => stdout.includes('LEAD-PARKED'), 'the lead did not park')
  const parkedAt = Date.now()
  check('the lead spawned water in-process into its crew, started a background shell and parked (its turn ended with the shell still running)', parked && existsSync(inboxPath), stdout.slice(-300))
  const waited = await waitFor(() => stdout.includes('"waiting_on_agents"'), 'the lead did not announce its wait', 5_000)
  check("the parked lead announces the background wait — the driver sits in its agent-wait loop, not idle", waited, stdout.split('\n').filter(line => line.includes('waiting_on_agents')).slice(0, 2).join(' | '))

  const landed = await waitFor(() => (readInbox() ?? []).some(row => row.text === 'READY-WATER'), "water's report did not land", 40_000)
  const landedAt = Date.now()
  const row = (readInbox() ?? []).find(candidate => candidate.text === 'READY-WATER')
  check("water's report landed in the lead's inbox (an in-process teammate's SendMessage) after the lead parked", landed && row !== undefined && landedAt >= parkedAt, JSON.stringify(row))

  const woke = await waitFor(() => turnOpenedWith('READY-WATER') !== undefined, 'the report did not wake the lead', WAKE_WINDOW_MS)
  const wakeMs = Date.now() - landedAt
  const wakeRequest = turnOpenedWith('READY-WATER')
  check(`the report reaches the parked lead as a turn within ${WAKE_WINDOW_MS / 1000} s — a request whose opening user content is the teammate-message`, woke, woke ? `${wakeMs} ms after the row landed` : `no such request in ${WAKE_WINDOW_MS / 1000} s; lead requests ${leadRequests().length}; inbox ${JSON.stringify((readInbox() ?? []).map(candidate => ({ text: candidate.text.slice(0, 40), read: candidate.read, delivery: candidate.delivery !== undefined })))}`)
  check('the report is delivered exactly once', blocksIn(wakeRequest, 'READY-WATER') === 1 && leadRequests().filter(request => openingOf(request).includes('READY-WATER')).length <= 1, `blocks ${blocksIn(wakeRequest, 'READY-WATER')}`)

  const acknowledged = await waitFor(() => (readInbox() ?? []).some(row => row.text === 'READY-WATER' && row.read === true), 'the report was not marked read', WAKE_WINDOW_MS)
  check('the row is marked read once its turn has carried it', acknowledged, JSON.stringify((readInbox() ?? []).find(candidate => candidate.text === 'READY-WATER')))

  const idleWoke = await waitFor(() => leadRequests().some(request => openingOf(request).includes('idle_notification') && openingOf(request).includes('"water"')), "water's idle notification did not wake the lead", WAKE_WINDOW_MS + 4_000)
  check("water's idle notification reaches the lead as a turn too (its own, or folded into the report's)", idleWoke, `lead requests ${leadRequests().length}`)

  const { writeToMailbox } = await import('../../src/utils/teammateMailbox.ts')
  const outsideAt = Date.now()
  const written = await writeToMailbox('team-lead', { from: 'outside', text: 'HELLO-FROM-OUTSIDE', timestamp: new Date().toISOString(), summary: 'HELLO-FROM-OUTSIDE' }, team)
  check('a row written from another process the way SendMessage writes it lands in the inbox', written && (readInbox() ?? []).some(row => row.text === 'HELLO-FROM-OUTSIDE'))
  const outsideWoke = await waitFor(() => turnOpenedWith('HELLO-FROM-OUTSIDE') !== undefined, 'the outside row did not wake the lead', WAKE_WINDOW_MS)
  check(`a cross-process row reaches the parked lead as a turn within ${WAKE_WINDOW_MS / 1000} s`, outsideWoke, outsideWoke ? `${Date.now() - outsideAt} ms after the write` : `no such request; inbox ${JSON.stringify((readInbox() ?? []).map(candidate => ({ text: candidate.text.slice(0, 40), read: candidate.read })))}`)
  check('the outside row is delivered exactly once', blocksIn(turnOpenedWith('HELLO-FROM-OUTSIDE'), 'HELLO-FROM-OUTSIDE') === 1 && leadRequests().filter(request => openingOf(request).includes('HELLO-FROM-OUTSIDE')).length === 1)

  submit('MIDTURN-CHECK')
  const midturnStarted = await waitFor(() => leadRequests().some(request => openingOf(request).includes('MIDTURN-CHECK')), 'the mid-turn fixture did not start')
  check('the lead enters a paced request before the mid-turn report arrives', midturnStarted)
  await writeToMailbox('team-lead', { from: 'outside', text: 'REPORT-AT-BOUNDARY', timestamp: new Date().toISOString() }, team)
  const atBoundary = await waitFor(() => leadRequests().some(request => JSON.stringify(request.body.messages).includes('REPORT-AT-BOUNDARY')), 'the report missed the tool boundary', WAKE_WINDOW_MS)
  check('a report arriving mid-turn is consumed at the next tool boundary', atBoundary)
  const boundaryRead = await waitFor(() => (readInbox() ?? []).some(row => row.text === 'REPORT-AT-BOUNDARY' && row.read === true), 'the boundary report was not acknowledged', WAKE_WINDOW_MS)
  check('the queued-command attachment acknowledges the mid-turn report', boundaryRead)
  const lastRequest = leadRequests().at(-1)
  const boundaryMessages = (lastRequest?.body.messages ?? []).filter(message => JSON.stringify(message).includes('REPORT-AT-BOUNDARY'))
  check('the mid-turn report is present exactly once in the conversation', boundaryMessages.length === 1 && JSON.stringify(boundaryMessages).split('REPORT-AT-BOUNDARY').length === 2, JSON.stringify(boundaryMessages))
} finally {
  child.kill('SIGTERM')
  await exit
  await fixture.close()
  rmSync(world, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`FAIL prove-lead-mail-wake: ${failures} failure(s)`)
  process.exit(1)
}
console.log("PASS lead-mail-wake: teammate reports reach a parked headless lead as turns, in-process and across processes, and mid-turn reports land once at the next tool boundary")
