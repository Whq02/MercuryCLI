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
const crews = join(world, 'crews')
mkdirSync(project)
seedFirstRun(config, [project])
process.env.MERCURY_CONFIG_DIR = config
process.env.MERCURY_CREWS_DIR = crews
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const verbose = process.argv.includes('--verbose')
const startedAt = Date.now()
const trace = (event: string, detail: unknown): void => {
  if (verbose) console.log(`  [TRACE +${Date.now() - startedAt} ms] ${event} ${JSON.stringify(detail)}`)
}
const WAKE_WINDOW_MS = 8_000
const model = 'claude-fable-5-1'
const crewmateModel = 'claude-opus-4-6'
const sessionId = randomUUID()
const crew = sessionId
const lead = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model, whenModel: 'fable-5-1' } as ScriptedTurn)
const water = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: crewmateModel, whenModel: 'opus-4-6' } as ScriptedTurn)
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: 'water', crew_name: 'crew', model: crewmateModel, subagent_type: 'mercury-crew', description: 'Water report', prompt: 'Wait for REPORT-NOW, then send READY-WATER to crew-lead once.' } }),
  lead({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 120', run_in_background: true, description: 'A pool that outlives the window' } }),
  lead({ kind: 'text', text: 'LEAD-PARKED' }),
  lead({ kind: 'paced_tool_use', whenBody: 'MIDTURN-CHECK', preDeltas: ['Working', '.', '.'], gapMs: 1000, tools: [{ name: 'Bash', input: { command: 'pwd', description: 'Reach a tool boundary' } }] }),
  ...Array.from({ length: 12 }, (_, i) => lead({ kind: 'text', text: 'LEAD-ACK-' + i })),
  water({ kind: 'text', text: 'Water awaiting REPORT-NOW.' }),
  water({ kind: 'tool_use', whenBody: 'REPORT-NOW', name: 'SendMessage', input: { to: 'crew-lead', message: 'READY-WATER', summary: 'READY-WATER' } }),
  water({ kind: 'text', text: 'Water done.' }),
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const fixture = await startFixtureApi(script)
const child = spawn(node, [dist, 'run', ...(verbose ? ['--debug-to-stderr'] : []), '--input', 'rows', '--format', 'rows', '--model', model, '--mode', 'sovereign', '--allowed-tools', 'Agent', 'SendMessage', 'Bash', '--session-id', sessionId], {
  cwd: project,
  env: { HOME: world, PATH: '/usr/bin:/bin:' + dirname(node), TERM: 'dumb', MERCURY_CONFIG_DIR: config, MERCURY_CREWS_DIR: crews, MERCURY_DAEMON_DIR: join(world, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: fixture.url },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
let pendingFrames = ''
let waitingOnAgents = false
child.stdout.on('data', data => {
  stdout += data
  pendingFrames += data
  const lines = pendingFrames.split('\n')
  pendingFrames = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const frame = JSON.parse(line)
    if (frame.type !== 'system') continue
    if (frame.subtype === 'turn_started') waitingOnAgents = false
    if (frame.subtype === 'status') {
      waitingOnAgents = Number(frame.status?.waiting_on_agents ?? 0) > 0
      trace('lead status', frame.status)
    }
  }
})
child.stderr.on('data', data => { stderr += data })
let exited = false
const exit = new Promise<void>(resolveExit => child.on('close', () => { exited = true; resolveExit() }))
async function waitFor(predicate: () => boolean, label: string, limitMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + limitMs
  for (;;) {
    observe()
    if (predicate()) return true
    if (exited) throw new Error(`${label}: the lead exited\n${stdout.slice(-800)}\n${stderr.slice(-800)}`)
    if (Date.now() >= deadline) return false
    await new Promise(resolveTick => setTimeout(resolveTick, 20))
  }
}
const submit = (text: string) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
const inboxPath = join(config, 'crew', 'livecomms', `${crew}.json`)
type Row = { to?: string; text: string; read?: boolean; from: string; timestamp: string; delivery?: { id: string } }
const readInbox = (): Row[] | null => {
  if (!existsSync(inboxPath)) return null
  try {
    const file = JSON.parse(readFileSync(inboxPath, 'utf8')) as { messages?: Row[] }
    return (file.messages ?? []).filter(row => row.to === 'crew-lead')
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
const reportBlocks = (text: string, needle: string): number =>
  [...text.matchAll(/<crewmate-message\b[^>]*>([\s\S]*?)<\/crewmate-message>/g)].filter(match => match[1]!.trim() === needle).length
const opensWithReport = (request: Request, needle: string): boolean => {
  const opening = openingOf(request).replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/, '').trimStart()
  return opening.startsWith('<crewmate-message') && reportBlocks(opening, needle) > 0
}
const turnOpenedWith = (needle: string): Request | undefined =>
  leadRequests().find(request => opensWithReport(request, needle))
const blocksIn = (request: Request | undefined, needle: string): number => {
  if (request === undefined) return 0
  return (request.body.messages ?? []).filter(message => message.role === 'user').reduce((count, message) => count + reportBlocks(textOf(message), needle), 0)
}
const deliveredOnce = (needle: string, requests = leadRequests()): boolean =>
  requests.filter(request => opensWithReport(request, needle)).length === 1 && blocksIn(requests.at(-1), needle) === 1

let observedRequests = 0
const observedRows = new Map<string, string>()
function observe(): void {
  if (!verbose) return
  for (const row of readInbox() ?? []) {
    const key = `${row.from}:${row.timestamp}:${row.text}`
    const state = JSON.stringify(row)
    if (observedRows.get(key) === state) continue
    observedRows.set(key, state)
    trace('inbox row', row)
  }
  const requests = leadRequests()
  while (observedRequests < requests.length) {
    const request = requests[observedRequests++]!
    trace('lead request', { number: observedRequests, opening: openingOf(request), reportBlocks: blocksIn(request, 'READY-WATER') })
  }
}

console.log(`lead mail wake: world ${world} · bundle ${dist} · started ${new Date(startedAt).toISOString()}`)
try {
  const envelope = '<crewmate-message crewmate_id="water" summary="READY-WATER">\nREADY-WATER\n</crewmate-message>'
  const reminder = '<system-reminder>Tools changed.</system-reminder>\n'
  const sample = (...contents: string[]): Request => ({ body: { messages: contents.map(content => ({ role: 'user', content })) } })
  const plain = sample(envelope)
  const wrapped = sample(reminder + reminder + envelope)
  check('the turn recognizer accepts a report after leading system reminders', opensWithReport(plain, 'READY-WATER') && opensWithReport(wrapped, 'READY-WATER'))
  check('history, reminder-only and summary-only mentions are not report turns',
    !opensWithReport(sample(envelope, 'A later prompt'), 'READY-WATER') &&
    !opensWithReport(sample(`<system-reminder>${envelope}</system-reminder>`), 'READY-WATER') &&
    !opensWithReport(sample(envelope.replace('\nREADY-WATER\n', '\nidle_notification\n')), 'READY-WATER'))
  check('the exactly-once check rejects duplicate blocks and duplicate report turns',
    deliveredOnce('READY-WATER', [wrapped, sample(reminder + envelope, 'A later prompt')]) &&
    !deliveredOnce('READY-WATER', [sample(envelope + envelope)]) &&
    !deliveredOnce('READY-WATER', [plain, plain]) &&
    !deliveredOnce('READY-WATER', [sample('No report')]))

  const { sendLiveMessage } = await import('../../src/services/crew/liveComms.ts')
  submit('START: spawn water, start the pool, then park.')
  const parked = await waitFor(() => stdout.includes('LEAD-PARKED'), 'the lead did not park')
  check('the lead spawned water in-process into its crew, started a background shell and parked (its turn ended with the shell still running)', parked && existsSync(inboxPath), stdout.slice(-300))
  const waited = await waitFor(() => {
    const rows = readInbox() ?? []
    return waitingOnAgents && rows.some(row => row.text.includes('idle_notification')) && rows.every(row => row.read)
  }, 'the lead did not settle after the initial idle notification')
  const parkedAt = Date.now()
  trace('lead parked before report release', { parkedAt })
  check("the parked lead announces the background wait after water's first idle notification settles", waited && !(readInbox() ?? []).some(row => row.text === 'READY-WATER'))
  if (!waited) throw new Error('The lead never parked before the report release')
  if (!await sendLiveMessage(crew, { to: 'water', from: 'crew-lead', text: 'REPORT-NOW', timestamp: new Date().toISOString() })) throw new Error('Could not release water to send its report')

  const landed = await waitFor(() => (readInbox() ?? []).some(row => row.text === 'READY-WATER'), "water's report did not land", 40_000)
  const row = (readInbox() ?? []).find(candidate => candidate.text === 'READY-WATER')
  const landedAt = row === undefined ? Date.now() : Date.parse(row.timestamp)
  check("water's report landed in the lead's inbox (an in-process crewmate's SendMessage) after the lead parked", landed && row !== undefined && landedAt >= parkedAt, JSON.stringify(row))

  const woke = await waitFor(() => turnOpenedWith('READY-WATER') !== undefined, 'the report did not wake the lead', WAKE_WINDOW_MS)
  const wakeMs = Date.now() - landedAt
  check(`the report reaches the parked lead as a turn within ${WAKE_WINDOW_MS / 1000} s — its opening carries the report after any system reminders`, woke, woke ? `${wakeMs} ms after the row timestamp` : `no such request in ${WAKE_WINDOW_MS / 1000} s; lead requests ${leadRequests().length}; inbox ${JSON.stringify((readInbox() ?? []).map(candidate => ({ text: candidate.text.slice(0, 40), read: candidate.read, delivery: candidate.delivery !== undefined })))}`)

  const acknowledged = await waitFor(() => (readInbox() ?? []).some(row => row.text === 'READY-WATER' && row.read === true), 'the report was not marked read', WAKE_WINDOW_MS)
  check('the row is marked read once its turn has carried it', acknowledged, JSON.stringify((readInbox() ?? []).find(candidate => candidate.text === 'READY-WATER')))

  const idleWoke = await waitFor(() => (readInbox() ?? []).some(row => Date.parse(row.timestamp) >= parkedAt && row.text.includes('idle_notification') && leadRequests().some(request => openingOf(request).includes(row.text))), "water's idle notification did not wake the lead", WAKE_WINDOW_MS + 4_000)
  check("water's new idle notification reaches the lead as a turn too (its own, or folded into the report's)", idleWoke, `lead requests ${leadRequests().length}`)

  const outsideAt = Date.now()
  const written = await sendLiveMessage(crew, { to: 'crew-lead', from: 'outside', text: 'HELLO-FROM-OUTSIDE', timestamp: new Date().toISOString(), summary: 'HELLO-FROM-OUTSIDE' })
  check('a row written from another process the way SendMessage writes it lands in the inbox', written && (readInbox() ?? []).some(row => row.text === 'HELLO-FROM-OUTSIDE'))
  const outsideWoke = await waitFor(() => turnOpenedWith('HELLO-FROM-OUTSIDE') !== undefined, 'the outside row did not wake the lead', WAKE_WINDOW_MS)
  check(`a cross-process row reaches the parked lead as a turn within ${WAKE_WINDOW_MS / 1000} s`, outsideWoke, outsideWoke ? `${Date.now() - outsideAt} ms after the write` : `no such request; inbox ${JSON.stringify((readInbox() ?? []).map(candidate => ({ text: candidate.text.slice(0, 40), read: candidate.read })))}`)

  submit('MIDTURN-CHECK')
  const midturnStarted = await waitFor(() => leadRequests().some(request => openingOf(request).includes('MIDTURN-CHECK')), 'the mid-turn fixture did not start')
  check('the lead enters a paced request before the mid-turn report arrives', midturnStarted)
  await sendLiveMessage(crew, { to: 'crew-lead', from: 'outside', text: 'REPORT-AT-BOUNDARY', timestamp: new Date().toISOString() })
  const atBoundary = await waitFor(() => leadRequests().some(request => JSON.stringify(request.body.messages).includes('REPORT-AT-BOUNDARY')), 'the report missed the tool boundary', WAKE_WINDOW_MS)
  check('a report arriving mid-turn is consumed at the next tool boundary', atBoundary)
  const boundaryRead = await waitFor(() => (readInbox() ?? []).some(row => row.text === 'REPORT-AT-BOUNDARY' && row.read === true), 'the boundary report was not acknowledged', WAKE_WINDOW_MS)
  check('the queued-command attachment acknowledges the mid-turn report', boundaryRead)
  const lastRequest = leadRequests().at(-1)
  check('the report is delivered exactly once, including after later turns', deliveredOnce('READY-WATER'), `blocks ${blocksIn(lastRequest, 'READY-WATER')}`)
  check('the outside row is delivered exactly once, including after later turns', deliveredOnce('HELLO-FROM-OUTSIDE'), `blocks ${blocksIn(lastRequest, 'HELLO-FROM-OUTSIDE')}`)
  const boundaryMessages = (lastRequest?.body.messages ?? []).filter(message => JSON.stringify(message).includes('REPORT-AT-BOUNDARY'))
  check('the mid-turn report is present exactly once in the conversation', boundaryMessages.length === 1 && JSON.stringify(boundaryMessages).split('REPORT-AT-BOUNDARY').length === 2, JSON.stringify(boundaryMessages))
} finally {
  child.kill('SIGTERM')
  await exit
  await fixture.close()
  observe()
  if (verbose) console.log(`\nLead process stderr:\n${stderr}\nLead process stdout:\n${stdout}`)
  rmSync(world, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`FAIL prove-lead-mail-wake: ${failures} failure(s)`)
  process.exit(1)
}
console.log("PASS lead-mail-wake: crewmate reports reach a parked headless lead as turns, in-process and across processes, and mid-turn reports land once at the next tool boundary")
