#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, createConnection } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const root = mkdtempSync(join(tmpdir(), 'daemon-hook-road-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
mkdirSync(home)
mkdirSync(cwd)
const ledger = join(root, 'inputs.jsonl')
const closed = join(root, 'closed')
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const program = `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({...input,spawn_cwd:process.cwd()})+'\\n');process.stdout.write(JSON.stringify({systemMessage:input.hook_event_name+' from worker'})+'\\n')`
const command = `${quote(process.execPath)} -e ${quote(program)}`
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: Object.fromEntries(['SessionStart', 'Notification', 'SessionEnd'].map(event => [event, [{ hooks: [{ type: 'command', command }] }]])) } }))
const worker = spawn(process.execPath, [join(import.meta.dir, 'daemon-hook-fixture-worker.ts'), closed], {
  cwd: root,
  env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_TRUST_DIALOG_ACCEPTED: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
worker.stderr.on('data', chunk => { stderr += String(chunk) })
const exited = new Promise<number | null>(resolve => worker.once('close', resolve))
let peer: ReturnType<typeof createConnection> | undefined
const output = createInterface({ input: worker.stdout })
output.on('line', line => peer?.write(`${line}\n`))
const server = createServer(socket => {
  peer = socket
  socket.on('error', () => {})
  const input = createInterface({ input: socket })
  input.on('line', line => worker.stdin.write(`${line}\n`))
})
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const address = server.address() as { port: number }
const client = createConnection(address.port, '127.0.0.1')
await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
const marks: Array<Record<string, unknown>> = []
const replies = createInterface({ input: client })
let pending: (() => void) | undefined
replies.on('line', line => {
  const mark = JSON.parse(line) as Record<string, unknown>
  marks.push(mark)
  if (mark.kind === 'settled' || mark.kind === 'failed') pending?.()
})
let failures = 0
const check = (name: string, yes: boolean): void => {
  if (!yes) failures++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${name}`)
}
const guard = setTimeout(() => { console.error('FAIL fixture daemon exceeded its liveness deadline'); worker.kill('SIGTERM'); client.destroy(); process.exit(1) }, 60_000)
try {
  const expectedFields: Record<string, string> = { SessionStart: 'source', Notification: 'notification_type', SessionEnd: 'reason' }
  for (const [event, fields] of [
    ['SessionStart', { source: 'startup' }],
    ['Notification', { message: 'worker notification', notification_type: 'test' }],
    ['SessionEnd', { reason: 'other' }],
  ] as const) {
    const done = new Promise<void>(resolve => { pending = resolve })
    client.write(`${JSON.stringify({ event, fields, sessionId: 'worker-data-session', cwd, transcriptPath: join(root, 'worker-transcript.jsonl'), trustAccepted: true })}\n`)
    await done
    check(`${event} fired and completed in the worker`, marks.some(mark => mark.kind === 'response' && mark.hookEvent === event && mark.outcome === 'success' && String(mark.output).includes(`${event} from worker`)))
    check(`${event} output chunks emit progress marks without a screen`, marks.some(mark => mark.kind === 'progress' && mark.hookEvent === event))
    const eventMarks = marks.filter(mark => mark.sessionId === 'worker-data-session' && mark.hookEvent === event)
    check(`${event} carries the worker's data-in identity on every mark`, eventMarks.length > 0 && eventMarks.every(mark => mark.sessionId === 'worker-data-session'))
    check(`${event} emits exactly one started/response pair for one matched hook`, eventMarks.filter(mark => mark.kind === 'started').length === 1 && eventMarks.filter(mark => mark.kind === 'response').length === 1)
  }
  const records = existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
  check('all three hooks ran exactly once', records.length === 3)
  check('every hook input carries the data-in session identity', records.length === 3 && records.every(record => record.session_id === 'worker-data-session'))
  check('every hook input and child process carries the data-in cwd', records.length === 3 && records.every(record => record.cwd === cwd && record.spawn_cwd === cwd))
  check('every hook input carries the data-in transcript path', records.length === 3 && records.every(record => record.transcript_path === join(root, 'worker-transcript.jsonl')))
  const perEventCounts = Object.fromEntries(['SessionStart', 'Notification', 'SessionEnd'].map(event => [event, records.filter(record => record.hook_event_name === event).length]))
  check('each lifecycle event fired the worker hook exactly once', Object.values(perEventCounts).every(count => count === 1))
  for (const [event, field] of Object.entries(expectedFields)) {
    check(`${event} input carries its event field ${field}`, records.some(record => record.hook_event_name === event && String(record[field] ?? '') !== ''))
  }
  const done = new Promise<void>(resolve => { pending = resolve })
  client.write(`${JSON.stringify({ event: 'SessionStart', fields: { source: 'startup' }, sessionId: 'untrusted-worker', cwd, transcriptPath: join(root, 'untrusted.jsonl'), trustAccepted: false })}\n`)
  await done
  check('explicitly untrusted worker data cannot execute hooks even in a noninteractive worker', existsSync(ledger) && readFileSync(ledger, 'utf8').trim().split('\n').length === 3 && !marks.some(mark => mark.sessionId === 'untrusted-worker' && mark.kind === 'started'))
  check('no mark of another session ever crosses the worker wire', !marks.some(mark => mark.sessionId !== 'worker-data-session' && mark.sessionId !== 'untrusted-worker'))
  check('the fixture worker reported no engine exceptions', !marks.some(mark => mark.kind === 'failed' || mark.kind === 'assertion'))
} finally {
  worker.stdin.end()
  const code = await exited
  check('the fixture worker exits cleanly after its lifecycle', code === 0 && existsSync(closed))
  if (stderr) console.error(stderr)
  replies.close()
  client.destroy()
  peer?.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
  clearTimeout(guard)
  rmSync(root, { recursive: true, force: true })
}
console.log(failures === 0 ? 'DAEMON HOOK ROAD GREEN' : `${failures} DAEMON HOOK ROAD FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
