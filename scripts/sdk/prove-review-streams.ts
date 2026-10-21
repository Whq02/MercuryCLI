import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { connect, run, rowOf, inputRowOf, isMainThread, MercuryError, MercuryWireError } from '../../sdk/src/index.ts'
import { startFixtureServer } from '../../sdk/src/testing.ts'

const fake = (source: string) => ['node', '-e', source, '--']
const init = { protocol: 1, runner: { version: 'fixture', pid: 1 }, session_id: 's' }
const outcome = { type: 'outcome', seq: 1, timestamp: 't', session_id: 's', turn: 1, schema: 1, turn_id: 't', status: 'completed', steps: 1, wall_ms: 1, usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }, models: {}, denials: [] }
const future = { type: 'future', seq: 7, timestamp: 't', parent_call_id: 'agent', session_id: 's', turn: 2 }
const parsed = rowOf(future)
assert(parsed.ok && parsed.row.type === 'unknown_row')
assert.equal(parsed.row.original_type, 'future'); assert.equal(parsed.row.seq, 7); assert.equal(parsed.row.session_id, 's'); assert(!isMainThread(parsed.row))
for (const row of [{ type: 'prompt', content: '' }, { type: 'prompt', content: [] }, { type: 'shell', command: ' \r\n ' }, { type: 'note', to: '', content: 'x' }, { type: 'note', to: 'a', content: '' }]) assert(!inputRowOf(row).ok)
for (const door of ['run', 'runner']) {
  const mercury = fake("process.stdin.resume();process.stdout.write('x'.repeat(33*1024*1024)+'\\n');setInterval(()=>{},1000)")
  if (door === 'run') { const task = run({ mercury, prompt: 'x' }); await assert.rejects(task.outcome, e => e instanceof MercuryWireError && e.issues[0]?.message.includes('33554432')); await task.exit }
  else await assert.rejects(connect({ mercury }), e => e instanceof MercuryWireError && e.issues[0]?.message.includes('33554432'))
}
const framing = await connect({ mercury: fake(`process.stdin.once('data',()=>process.stdout.write(' \\n\\ufeff'+JSON.stringify({jsonrpc:'2.0',id:1,result:${JSON.stringify(init)}}).replace(',',',\\r')+'\\n'))`) })
await framing.close()
const dead = run({ mercury: fake('process.exit(0)'), input: 'rows' }); await dead.exit; await assert.rejects(dead.sendPrompt('x'), MercuryError)
const wire = run({ mercury: fake("console.log('{bad');setInterval(()=>{},1000)"), prompt: 'x' })
let emitted: unknown
wire.on('error', e => { emitted = e })
await assert.rejects(wire.outcome, e => e === emitted && e === wire.error && e instanceof MercuryWireError && e.exit !== null)
await wire.exit
const leak = await connect({ mercury: fake(`const rl=require('node:readline').createInterface({input:process.stdin});rl.once('line',()=>{console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:${JSON.stringify(init)}}));rl.once('line',()=>console.log('{bad'))});setInterval(()=>{},1000)`) })
await assert.rejects(leak.facts(), MercuryWireError)
await Promise.race([leak.exit, new Promise((_, reject) => setTimeout(() => reject(Error('child leaked')), 2000).unref())])
await assert.rejects(connect({ mercury: fake("process.stdin.once('data',()=>console.log(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'parse failure',data:{limit:32}}})))") }), e => e instanceof MercuryError && !(e instanceof MercuryWireError) && e.code === -32700 && (e.data as any).limit === 32)
for (const [status, code] of [['completed', 0], ['failed', 1], ['refused', 1], ['interrupted', 1]] as const) {
  const fixture = await startFixtureServer({ rows: [{ ...outcome, status }] })
  try { const task = run({ mercury: fixture.mercury, prompt: 'runner' }); await task.outcome.catch(() => undefined); assert.equal((await task.exit).code, code) } finally { await fixture.close() }
}
console.log('PASS review streams: envelope, empty input, byte limit, LF framing, writes, cleanup, stable errors, fixtures and null-id RPC errors')
const root = resolve(import.meta.dir, '../..')
const py = spawnSync('python3', [resolve(import.meta.dir, 'python-streams.py')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: resolve(root, 'sdk-py/src') }, encoding: 'utf8', timeout: 30000 })
console.log(py.stdout); assert.equal(py.status, 0, py.stderr)
