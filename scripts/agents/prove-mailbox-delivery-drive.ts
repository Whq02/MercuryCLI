#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const dist = join(root, 'dist/mercury.mjs')
if (!existsSync(dist)) throw new Error('Build the product before running this check')
const vendoredNode = join(root, 'dist/vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const node = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const world = mkdtempSync(join(tmpdir(), 'mail-delivery-drive-'))
const config = join(world, 'config')
const project = join(world, 'project')
const teams = join(world, 'teams')
mkdirSync(project)
seedFirstRun(config, [project])
const model = 'claude-fable-5-1'
const team = 'delivery-group'
const script: ScriptedTurn[] = []
const main = (turn: Record<string, unknown>, whenBody?: string) => ({ ...turn, model, whenModel: 'fable-5-1', ...(whenBody ? { whenBody } : {}) })
const send = (id: string, to: string, message: string) => ({ kind: 'tool_use', name: 'SendMessage', id, input: { to, message, summary: message } })
script.push(...[
  main({ kind: 'tool_use', name: 'TeamCreate', input: { team_name: team, description: 'Report delivery test' } }, 'START-GROUP'),
  main({ kind: 'tool_use', name: 'Agent', input: { name: 'water', team_name: team, model: 'claude-opus-4-6', subagent_type: 'mercury-general', description: 'Water report', prompt: 'Send READY-WATER to team-lead once.' } }, 'START-GROUP'),
  main({ kind: 'tool_use', name: 'Agent', input: { name: 'dragon', team_name: team, model: 'claude-sonnet-5', subagent_type: 'mercury-general', description: 'Dragon report', prompt: 'Send READY-DRAGON to team-lead once.' } }, 'START-GROUP'),
  main({ kind: 'text', text: 'GROUP-STARTED' }, 'START-GROUP'),
  main({ kind: 'text', text: 'FIRST-REPORT-RECEIVED' }, 'READY-WATER'),
  main(send('resume-water', 'water', 'RESUME-WATER: send REPORT-WATER-2 once.'), 'RESUME-GROUP'),
  main({ kind: 'tool_use', name: 'Workflow', input: { script: "export const meta = { name: 'report-wait', description: 'Wait for the test response', phases: [{ title: 'Wait' }] }; return await agent('Reply once.', { model: 'claude-opus-5', effort: 'max', phase: 'Wait' });" } }, 'RESUME-GROUP'),
  main({ kind: 'text', text: 'WORKFLOW-WAITING' }, 'RESUME-GROUP'),
  main({ kind: 'text', text: 'WORKFLOW-FINISHED' }, 'task-notification'),
  main({ kind: 'text', text: 'SECOND-REPORT-RECEIVED' }, 'REPORT-WATER-2'),
  ...Array.from({ length: 8 }, (_, i) => main({ kind: 'text', text: 'FINAL-' + i })),
  { ...send('water-report-1', 'team-lead', 'READY-WATER'), model: 'claude-opus-4-6', whenModel: 'opus-4-6' },
  { kind: 'text', text: 'Water idle.', model: 'claude-opus-4-6', whenModel: 'opus-4-6' },
  { ...send('water-report-2', 'team-lead', 'REPORT-WATER-2'), model: 'claude-opus-4-6', whenModel: 'opus-4-6', whenBody: 'RESUME-WATER' },
  { kind: 'text', text: 'Water done.', model: 'claude-opus-4-6', whenModel: 'opus-4-6' },
  { ...send('dragon-report', 'team-lead', 'READY-DRAGON'), model: 'claude-sonnet-5', whenModel: 'sonnet-5' },
  { kind: 'text', text: 'Dragon done.', model: 'claude-sonnet-5', whenModel: 'sonnet-5' },
  { kind: 'paced', deltas: ['Workflow test done.'], gapMs: 0, startDelayMs: 5000, whenModel: 'opus-5' },
] as ScriptedTurn[])
const fixture = await startFixtureApi(script)
const child = spawn(node, [dist, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--allowed-tools', 'Agent', 'SendMessage', 'TeamCreate', 'Workflow', '--teammate-mode', 'in-process', '--session-id', randomUUID()], {
  cwd: project,
  env: { HOME: world, PATH: '/usr/bin:/bin:' + dirname(node), TERM: 'dumb', MERCURY_CONFIG_DIR: config, MERCURY_TEAMS_DIR: teams, MERCURY_DAEMON_DIR: join(world, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: fixture.url },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', data => { stdout += data })
child.stderr.on('data', data => { stderr += data })
let exited = false
const exit = new Promise<void>(resolveExit => child.on('close', () => { exited = true; resolveExit() }))
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  let expired = false
  const deadline = setTimeout(() => { expired = true }, 60_000)
  try {
    while (!predicate()) {
      if (expired || exited) throw new Error(label + '\n' + stdout.slice(-800) + '\n' + stderr.slice(-800))
      await new Promise(resolveTick => setTimeout(resolveTick, 20))
    }
  } finally {
    clearTimeout(deadline)
  }
}
const submit = (text: string) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
const inboxPath = join(teams, team, 'inboxes/team-lead.json')
let lockHeld = false
let lockReleased = false
let lockRefresh: ReturnType<typeof setInterval> | undefined
let lockRelease: ReturnType<typeof setTimeout> | undefined
const readInbox = (): Array<{ text: string; read?: boolean; from: string }> | null => {
  if (!existsSync(inboxPath)) return null
  try {
    return JSON.parse(readFileSync(inboxPath, 'utf8')) as Array<{ text: string; read?: boolean; from: string }>
  } catch {
    return null
  }
}
const observe = setInterval(() => {
  if (lockHeld) return
  const messages = readInbox()
  if (messages === null) return
  if (!messages.some(message => !message.read && message.text === 'REPORT-WATER-2') || messages.filter(message => !message.read && message.from === 'water').length < 2) return
  const lock = inboxPath + '.lock'
  try {
    mkdirSync(lock)
  } catch {
    return
  }
  lockHeld = true
  lockRefresh = setInterval(() => { const now = new Date(); if (existsSync(lock)) utimesSync(lock, now, now) }, 500)
  lockRelease = setTimeout(() => {
    clearInterval(lockRefresh)
    rmSync(lock, { recursive: true, force: true })
    lockReleased = true
  }, 9000)
}, 20)
try {
  submit('START-GROUP: create both teammates and receive their reports.')
  await waitFor(() => stdout.includes('FIRST-REPORT-RECEIVED'), 'First report did not arrive')
  submit('RESUME-GROUP: resume water, then run a workflow while its report arrives.')
  await waitFor(() => stdout.includes('SECOND-REPORT-RECEIVED') && lockReleased, 'The resumed report did not settle across the held lock')
  await waitFor(() => { const messages = readInbox(); return messages !== null && messages.every(message => message.read) }, 'Acknowledgements did not settle')
  submit('Finish by checking whether any report arrived again.')
  await waitFor(() => stdout.includes('FINAL-'), 'Final check did not settle')
  const requests = fixture.messageRequests()
  const parent = requests.filter(request => request.body.model === model)
  const last = parent.at(-1)!.body as { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> }
  const reports = last.messages.filter(message => message.role === 'user').flatMap(message => {
    const text = typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    return [...text.matchAll(/<teammate-message\b[^>]*>([\s\S]*?)<\/teammate-message>/g)].map(match => match[1]!)
  })
  const counts = ['READY-WATER', 'READY-DRAGON', 'REPORT-WATER-2'].map(name => ({ name, count: reports.filter(text => text.includes(name)).length }))
  console.log(JSON.stringify({ counts, lockHeld, lockReleased, requests: requests.length, workflowRequests: requests.filter(request => request.body.model === 'claude-opus-5').length }))
  if (!lockHeld || !lockReleased || !counts.every(row => row.count === 1) || !requests.some(request => request.body.model === 'claude-opus-5')) throw new Error('Reports were not delivered exactly once while the workflow ran')
  console.log('Built report delivery passed')
} finally {
  clearInterval(observe)
  clearInterval(lockRefresh)
  clearTimeout(lockRelease)
  child.kill('SIGTERM')
  await exit
  await fixture.close()
  rmSync(world, { recursive: true, force: true })
}
