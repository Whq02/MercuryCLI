/// <reference types="node" preserve="true" />
/// <reference lib="esnext.disposable" preserve="true" />
import { ROW_SCHEMAS, OUTCOME_EXIT_CODES, type JsonSchema, type SessionRow, type OutcomeRow, type TurnRow } from './rows.js'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { rowOf, type StreamRow } from './parse.js'
import { METHODS, type MethodName } from './wire.js'
import { validate } from './validate.js'

export type FixtureMessage = Record<string, unknown>
export type FixtureReply = { result?: unknown; error?: { code: number; message: string; data?: unknown }; before?: readonly FixtureMessage[]; after?: readonly FixtureMessage[] }
export type Fixture = { validate?: boolean; rows?: readonly (StreamRow | FixtureMessage)[]; inputCount?: number; methods?: Readonly<Record<string, readonly FixtureReply[]>>; answers?: Readonly<Record<string, readonly FixtureMessage[]>> }

export async function startFixtureServer(fixture: Fixture) {
  if (fixture.validate !== false) validateFixture(fixture)
  const received: FixtureMessage[] = []
  const sockets = new Set<Socket>()
  const token = randomBytes(32).toString('hex')
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    const cursors: Record<string, number> = {}
    let door = ''
    let inputs = 0
    const send = (message: unknown) => socket.write(JSON.stringify(message) + '\n')
    const replay = () => { for (const row of fixture.rows ?? []) send(row); socket.end() }
    lines.on('line', line => {
      try {
        const msg = JSON.parse(line)
        if (!door) {
          if (msg.token !== token) { socket.destroy(); return }
          door = msg.door
          if (door === 'run' && !fixture.inputCount) replay()
          return
        }
        received.push(msg)
        if (door === 'run') { if (++inputs >= (fixture.inputCount ?? 0)) replay(); return }
        if (!msg.method) { for (const row of fixture.answers?.[String(msg.id)] ?? []) send(row); return }
        const replies = fixture.methods?.[msg.method]
        const reply = replies?.[cursors[msg.method] ?? 0]
        cursors[msg.method] = (cursors[msg.method] ?? 0) + 1
        if (msg.id === undefined) return
        if (!reply) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no recorded response for ${msg.method}` } }); return }
        for (const row of reply.before ?? []) send(row)
        send({ jsonrpc: '2.0', id: msg.id, ...(reply.error ? { error: reply.error } : { result: reply.result ?? {} }) })
        for (const row of reply.after ?? []) send(row)
      } catch { socket.destroy() }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as { port: number }
  const bridge = `const net=require('node:net');const args=process.argv.slice(1);const boundary=args.findIndex(a=>a==='--'||a==='--format');const head=args.slice(0,boundary<0?args.length:boundary);const door=head.some((a,i)=>a==='runner'&&head[i-1]!=='--project')?'runner':'run';let buffer='';const s=net.connect(${port},'127.0.0.1',()=>{s.write(JSON.stringify({token:${JSON.stringify(token)},door})+'\\n');process.stdin.pipe(s)});s.setEncoding('utf8');s.on('data',chunk=>{process.stdout.write(chunk);if(door!=='run')return;buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const row=JSON.parse(line);if(row.type==='outcome')process.exitCode=(${JSON.stringify(OUTCOME_EXIT_CODES)})[row.status]??1}catch{}}});s.on('end',()=>{process.stdin.destroy()});s.on('error',e=>{console.error(e.message);process.exitCode=1;process.stdin.destroy()});`
  const close = async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) }
  return { mercury: ['node', '-e', bridge, '--'] as readonly string[], received, close, [Symbol.asyncDispose]: close }
}

function defaults(schema: JsonSchema): unknown {
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.anyOf || schema.oneOf) return defaults((schema.anyOf ?? schema.oneOf)![0]!)
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map(key => [key, defaults(schema.properties![key]!)]))
  if (schema.type === 'array') return []
  if (schema.type === 'string') return 'fixture'
  if (schema.type === 'boolean') return false
  if (schema.type === 'null') return null
  if (schema.type === 'number' || schema.type === 'integer') return Math.max(0, schema.minimum ?? 0, (schema.exclusiveMinimum ?? -1) + 1)
  return null
}
const envelope = { seq: 1, timestamp: '2000-01-01T00:00:00.000Z', session_id: 'fixture-session' }
export function fixtureSessionRow(overrides: Partial<SessionRow> = {}): SessionRow { return { ...defaults(ROW_SCHEMAS.session) as SessionRow, ...envelope, ...overrides } }
export function fixtureOutcomeRow<T = unknown>(overrides: Partial<OutcomeRow<T>> = {}): OutcomeRow<T> { return { ...defaults(ROW_SCHEMAS.outcome) as OutcomeRow<T>, ...envelope, seq: 3, turn_id: 'fixture-turn', status: 'completed', ...overrides } }
export function fixtureTurn(overrides: Partial<OutcomeRow> = {}, promptId = 'fixture-prompt'): [TurnRow, OutcomeRow] {
  const outcome = fixtureOutcomeRow(overrides)
  const turn = { ...defaults(ROW_SCHEMAS.turn) as TurnRow, ...envelope, seq: outcome.seq - 1, turn_id: outcome.turn_id, message_ids: [promptId] }
  return [turn, outcome]
}
function validateFixture(fixture: Fixture): void {
  const message = (value: FixtureMessage | StreamRow): void => {
    if (!value || typeof value !== 'object') throw new Error('invalid fixture message')
    if ('type' in value) { const parsed = rowOf(value); if (!parsed.ok) throw new Error('invalid fixture row: ' + JSON.stringify(parsed)); return }
    const method = value.method as MethodName
    const spec = METHODS[method]
    if (value.jsonrpc !== '2.0' || !spec) throw new Error('invalid fixture message')
    if (method === 'row') { message(value.params as FixtureMessage); return }
    const issues = validate(spec.params, value.params)
    if (issues.length) throw new Error('invalid fixture params: ' + JSON.stringify(issues))
  }
  for (const row of fixture.rows ?? []) message(row)
  for (const [name, replies] of Object.entries(fixture.methods ?? {})) {
    const spec = METHODS[name as MethodName]
    if (!spec || spec.kind !== 'request') throw new Error('invalid fixture method: ' + name)
    for (const reply of replies) {
      if (reply.error) { if (!Number.isInteger(reply.error.code) || typeof reply.error.message !== 'string') throw new Error('invalid fixture error') }
      else { const issues = validate(spec.result, reply.result ?? {}); if (issues.length) throw new Error('invalid fixture result: ' + JSON.stringify(issues)) }
      for (const row of [...(reply.before ?? []), ...(reply.after ?? [])]) message(row)
    }
  }
  for (const messages of Object.values(fixture.answers ?? {})) for (const row of messages) message(row)
}
