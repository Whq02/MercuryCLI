#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'
import { DIST, LEAD_GATE, LEAD_MODEL, NODE, RECORD, record } from '../crew/crew-world.ts'

const VSHOT = join(import.meta.dir, '..', 'ui', 'vshot.py')
const PYTHON_USER_SITE = spawnSync('/usr/bin/python3', ['-c', 'import site; print(site.getusersitepackages())'], { encoding: 'utf8' }).stdout.trim()
const COLS = 120
const ROWS = 40
const sessionId = randomUUID()
const crew = sessionId
const worker = 'worker'
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const SECOND = 'SECOND-TURN'
const WORKER_PROMPT = 'WORKER-PROMPT'
const REPLY = 'LEAD-TURN-REPLY: the worker reports while the lead sits at its prompt.'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', whenBody: when }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, crew_name: crew, model: peerModel, subagent_type: 'mercury-crew', description: 'Reports to the lead', prompt: `${WORKER_PROMPT}: report to crew-lead.` } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-DONE' }, FIRST),
  lead({ kind: 'text', text: 'LEAD-SECOND' }, SECOND),
  ...Array.from({ length: 6 }, ack),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'crew-lead', message: REPLY, summary: 'the report' } }, WORKER_PROMPT),
  peer({ kind: 'text', text: 'WORKER-DONE' }, WORKER_PROMPT),
]

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

if (!existsSync(DIST)) throw new Error(`no bundle at ${DIST} — build the product first`)
const fixture = await startFixtureApi(script)
const dir = mkdtempSync(join(realpathSync(tmpdir()), 'lead-turn-crewmate-'))
const config = join(dir, 'config')
const project = join(dir, 'project')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# fixture\n')
seedFirstRun(config, [project])
const out = join(dir, 'grid.json')
const cfgPath = join(dir, 'cfg.json')
type Send = Record<string, unknown>
const awaits = (needle: string, data: string, extra: Send = {}): Send => ({ requireAwait: true, awaitText: needle, awaitSettleTicks: 3, minTick: 5, data, ...extra })
const sends: Send[] = [
  awaits('Yes, I accept', '\x1b[B'),
  awaits('❯ 2. Yes, I accept', '\r'),
  { atTick: 300, awaitText: '↵ start', minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: '', mark: 'face' },
  awaits('↵ start', '\r', { mark: 'enter' }),
  awaits('Type a prompt', `${FIRST}: spawn the worker and stop.\r`),
  awaits('LEAD-DONE', '', { mark: 'lead-done' }),
  { atTick: 500, awaitText: 'LEAD-ACK', minTick: 3, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'after-worker' },
  awaits('LEAD-ACK', `${SECOND}: anything from the worker?\r`),
  awaits('LEAD-SECOND', '', { mark: 'second' }),
  awaits('LEAD-SECOND', '', { mark: 'final' }),
]
writeFileSync(cfgPath, JSON.stringify({
  argv: [NODE, DIST, '--model', LEAD_MODEL, '--mode', 'sovereign', '--session-id', sessionId],
  cwd: project,
  sends,
  readyText: ['LEAD-SECOND'],
  readySettleTicks: 4,
  total: 600,
  cols: COLS,
  rows: ROWS,
  out,
}))
const env: NodeJS.ProcessEnv = {
  ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
  HOME: dir,
  PATH: `/usr/bin:/bin:${dirname(NODE)}`,
  PYTHONPATH: PYTHON_USER_SITE,
  TERM: 'xterm-256color',
  MERCURY_CONFIG_DIR: config,
  MERCURY_DAEMON_DIR: join(dir, 'daemon'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  ANTHROPIC_BASE_URL: fixture.url,
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_SPLASH: 'off',
  MERCURY_OPERATOR: 'sam',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_OASIS_BG: '0',
}
const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
let driverOut = ''
child.stdout.on('data', d => (driverOut += d))
child.stderr.on('data', d => (driverOut += d))
const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150_000))
const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
clearTimeout(killer)
await fixture.close()

type Cell = { c: string }
type Payload = { grid: Cell[][]; marks?: Array<{ label: string; grid: Cell[][] }>; endReason?: string }
const rowsOf = (grid: Cell[][]): string[] => grid.map(r => r.map(c => c.c || ' ').join(''))
const marks = new Map<string, string[]>()
let endReason = ''
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
  endReason = payload.endReason ?? ''
  for (const mark of payload.marks ?? []) marks.set(mark.label, rowsOf(mark.grid))
}
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
const requests = fixture.requests.filter(r => r.path.includes('/v1/messages')) as unknown as Request[]
const leadRequests = requests.filter(r => r.body.model === LEAD_MODEL)
const peerRequests = requests.filter(r => r.body.model === peerModel)
const lastUser = (r: Request): string => {
  const last = r.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const carries = (r: Request): boolean => lastUser(r).includes('LEAD-TURN-REPLY')
const secondIndex = leadRequests.findIndex(r => lastUser(r).includes(SECOND))
const wakeBeforeSecond = leadRequests.slice(0, secondIndex < 0 ? leadRequests.length : secondIndex).find(carries)
const secondCarries = secondIndex >= 0 && carries(leadRequests[secondIndex]!)
const frame = (label: string): string => (marks.get(label) ?? []).join('\n')
for (const label of ['face', 'enter', 'lead-done', 'after-worker', 'second', 'final']) record(`frame-${label}.txt`, frame(label) + '\n')
record('lead-requests.json', JSON.stringify(leadRequests.map(r => ({ last: lastUser(r).slice(0, 600) })), null, 2))
record('peer-requests.json', JSON.stringify(peerRequests.map(r => ({ last: lastUser(r).slice(0, 300) })), null, 2))

section('an interactive lead (a real PTY) spawns a crewmate that reports to crew-lead by SendMessage; the lead sits at its prompt')
check('the product booted to the composer, the lead finished its first turn and answered the second prompt', status === 0 && marks.has('lead-done') && marks.has('second'), `vshot ${status} end=${endReason}; ${driverOut.split('\n').filter(Boolean).slice(-3).join(' | ')}`)
check('the crewmate ran and called SendMessage to the lead (the wire shows its tool result)', peerRequests.some(r => lastUser(r).includes('tool_result') && lastUser(r).includes('delivered')), peerRequests.map(r => lastUser(r).slice(0, 160)).join(' || '))
section('the crewmate\'s message opens the lead\'s next turn by itself: no tool call, no prompt from the owner')
const block = `<crewmate-message crewmate_id=\\"${worker}\\" color=\\"red\\" summary=\\"the report\\">\\n${REPLY}\\n</crewmate-message>`
check('a lead request opens with the crewmate\'s message alone, before the owner\'s second prompt', wakeBeforeSecond !== undefined, leadRequests.map(r => lastUser(r).slice(0, 120)).join(' || '))
check('that turn carries the crewmate-message block in the wire\'s own words: crewmate_id, color, summary, the text', wakeBeforeSecond !== undefined && lastUser(wakeBeforeSecond).includes(block), wakeBeforeSecond === undefined ? '' : lastUser(wakeBeforeSecond).slice(0, 400))
check('the message and the lead\'s answer are painted in the chat before the owner types again', /@worker the report/.test(frame('after-worker')) && /LEAD-ACK/.test(frame('after-worker')), frame('after-worker').split('\n').filter(r => r.trim() !== '').slice(-8).join(' | '))
check('the owner\'s next prompt does not carry the message again: delivered once', secondIndex >= 0 && !secondCarries, secondIndex < 0 ? `no SECOND request among ${leadRequests.length}` : lastUser(leadRequests[secondIndex]!).slice(0, 300))
const crews = join(dir, 'crews')
const inboxFiles = existsSync(crews) ? spawnSync('/usr/bin/find', [crews, '-path', '*inboxes*'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean) : []
check('no per-member inbox file was written: the message rode the crew\'s live store', inboxFiles.length === 0, inboxFiles.join(', '))

if (failures === 0 && RECORD === undefined) rmSync(dir, { recursive: true, force: true })
else console.log(`world: ${dir}`)
console.log(failures === 0 ? '\nprove-lead-turn-crewmate-message: ALL LAWS HOLD' : `\nprove-lead-turn-crewmate-message: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
