import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { connect, MercuryError, METHODS } from '../../sdk/src/index.ts'
import { startFixtureServer } from '../../sdk/src/testing.ts'

const failures: string[] = []
async function check(name: string, test: () => Promise<void>) {
  try { await test(); console.log(`PASS ${name}`) } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error}`) }
}
const init = { protocol: 1, runner: { version: 'fixture', pid: 1 }, session_id: 's' }
await check('B1/B2 runner argv and partial negotiation', async () => {
  const fixture = await startFixtureServer({ methods: { initialize: [{ result: init }] } })
  try {
    const session = await connect({ mercury: fixture.mercury, partial: true })
    try {
      assert(!session.child.spawnargs.includes('--partial'))
      assert(!session.child.spawnargs.includes('--session-id'))
      assert.equal((fixture.received[0]!.params as any).capabilities.partial_rows, true)
    } finally { await session.close() }
  } finally { await fixture.close() }
})
await check('B5 prompt correlation with queued and abandoned turns', async () => {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin}); let turn=0;
const send=x=>console.log(JSON.stringify(x));
const outcome=(n)=>({type:'outcome',seq:n,timestamp:'t',session_id:'s',turn:n,schema:1,turn_id:'turn-'+n,status:'completed',steps:1,wall_ms:1,usage:{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0},models:{},denials:[]});
rl.on('line',l=>{const m=JSON.parse(l); if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:${JSON.stringify(init)}});if(m.method==='queue/add'){const n=++turn; send({jsonrpc:'2.0',method:'row',params:{type:'turn',seq:n,timestamp:'t',session_id:'s',turn:n,state:'started',turn_id:'turn-'+n,message_ids:[m.params.id||'missing']}});send({jsonrpc:'2.0',id:m.id,result:{accepted:true}});if(n===2){send({jsonrpc:'2.0',method:'row',params:outcome(1)});send({jsonrpc:'2.0',method:'row',params:outcome(2)})}}});`
  for (const timedOut of [false, true]) {
    const source = timedOut ? script.replace("send({jsonrpc:'2.0',id:m.id,result:{accepted:true}});", "if(n>1)send({jsonrpc:'2.0',id:m.id,result:{accepted:true}});") : script
    const session = await connect({ mercury: ['node', '-e', source, '--'] })
    const deadline = METHODS['queue/add'].deadlineMs
    try {
      if (timedOut) {
        METHODS['queue/add'].deadlineMs = 30
        await assert.rejects(session.prompt('timed out earlier'), MercuryError)
        METHODS['queue/add'].deadlineMs = deadline
      } else await session.sendPrompt('previous turn')
      const answer = await session.prompt('this turn')
      assert.equal(answer.turn_id, 'turn-2')
    } finally { METHODS['queue/add'].deadlineMs = deadline; await session.close() }
  }
})
await check('B6 void handlers and invalid permission answer', async () => {
  const fixture = await startFixtureServer({ methods: { initialize: [{ result: init }], 'session/facts': [{ result: {}, before: [
    { jsonrpc: '2.0', id: 50, method: 'fs/write_text_file', params: { path: '/fixture/file', content: 'x' } },
    { jsonrpc: '2.0', id: 51, method: 'terminal/kill', params: { terminal_id: 't' } },
    { jsonrpc: '2.0', id: 52, method: 'terminal/release', params: { terminal_id: 't' } },
    { jsonrpc: '2.0', id: 53, method: 'permission/request', params: { kind: 'tool', tool_use_id: 'u', tool_name: 'Read', input: {} } },
  ] }] } })
  try {
    const session = await connect({ mercury: fixture.mercury, handlers: { 'fs/write_text_file': async () => {}, 'terminal/kill': () => {}, 'terminal/release': () => {} }, onPermissionRequest: (() => undefined) as any })
    try { await session.facts() } finally { await session.close() }
    for (const id of [50, 51, 52]) assert.deepEqual(fixture.received.find(m => m.id === id)?.result, {})
    assert.equal((fixture.received.find(m => m.id === 53)?.error as any)?.code, -32603)
  } finally { await fixture.close() }
})
const root = resolve(import.meta.dir, '../..')
const python = spawnSync('python3', [resolve(import.meta.dir, 'python-blockers.py')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: resolve(root, 'sdk-py/src') }, encoding: 'utf8', timeout: 30000 })
console.log(python.stdout); if (python.status !== 0) { failures.push('Python blockers'); console.error(python.stderr) }
assert.deepEqual(failures, [])
