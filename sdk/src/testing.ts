/// <reference types="node" preserve="true" />
/// <reference lib="esnext.disposable" preserve="true" />
import { OUTCOME_EXIT_CODES } from './rows.js'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

export type FixtureMessage = Record<string, unknown>
export type FixtureReply = { result?: unknown; error?: { code: number; message: string; data?: unknown }; before?: FixtureMessage[]; after?: FixtureMessage[] }
export type Fixture = { rows?: FixtureMessage[]; inputCount?: number; methods?: Record<string, FixtureReply[]>; answers?: Record<string, FixtureMessage[]> }

export async function startFixtureServer(fixture: Fixture) {
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
