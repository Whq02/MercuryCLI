import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as sdk from '../../sdk/src/index.ts'
import { startFixtureServer } from '../../sdk/src/testing.ts'

const fake = (script: string) => ['node', '-e', script, '--']
const cases = [
  ["process.stderr.write('usage example');process.exit(2)", sdk.MercuryUsageError],
  ['process.exit(3)', sdk.MercuryExitError],
  ["console.log('{broken')", sdk.MercuryWireError],
] as const
for (const [script, error] of cases) {
  const task = sdk.run({ mercury: fake(script), prompt: 'hello' })
  await assert.rejects(task.outcome, e => e instanceof error)
  await assert.rejects(task.session, e => e instanceof error)
  await task.exit
}
const absent = sdk.run({ mercury: 'mercury-sdk-no-such-binary-proof', prompt: 'hi' })
await assert.rejects(absent.outcome, sdk.MercurySpawnError)
await assert.rejects(sdk.connect({ mercury: fake("process.stdin.once('data',()=>{console.log(JSON.stringify({jsonrpc:'2.0',id:'not-a-number',result:{}}));process.stdin.resume()});process.stdin.on('end',()=>process.exit(0))") }), sdk.MercuryWireError)
const init = { protocol: 1, runner: { version: 'fixture', pid: 1 }, session_id: 's' }
const refused = await startFixtureServer({ methods: { initialize: [{ result: init }], 'session/set_mode': [{ error: { code: -32010, message: 'no mode', data: { kind: 'mode' } } }] } })
try {
  const session = await sdk.connect({ mercury: [...refused.mercury, 'run'] })
  try {
    await assert.rejects(session.setMode('wrong'), e => e instanceof sdk.MercuryRefusal && e.code === -32010)
    await assert.rejects(session.interrupt({ hard: 'yes' as any }), sdk.MercuryWireError)
  } finally { await session.close() }
} finally { await refused.close() }

let aborted = false
const requests = await startFixtureServer({ methods: {
  initialize: [{ result: init }],
  'session/facts': [{ result: {}, before: [
    { jsonrpc: '2.0', id: 9, method: 'permission/request', params: { kind: 'tool', tool_use_id: 'call', tool_name: 'Write', input: {} } },
    { jsonrpc: '2.0', method: '$/cancel_request', params: { request_id: 9 } },
  ] }],
} })
try {
  const session = await sdk.connect({ mercury: requests.mercury, onPermissionRequest: async (_, context) => new Promise(resolve => context.signal.addEventListener('abort', () => { aborted = true; resolve({ outcome: 'deny' }) }, { once: true })) })
  try { await session.facts(); assert(aborted) } finally { await session.close() }
  assert(!requests.received.some(m => m.id === 9 && 'result' in m))
} finally { await requests.close() }

const scratch = mkdtempSync(join(tmpdir(), 'sdk-errors-'))
try {
  const code = `import asyncio,json,sys\nfrom mercury_cli_sdk import *\nfrom mercury_cli_sdk.testing import start_fixture_server\nasync def main():\n for script,error in [('import sys;sys.stderr.write("usage");sys.exit(2)',MercuryUsageError),('raise SystemExit(3)',MercuryExitError),('print("{broken")',MercuryWireError)]:\n  task=await run('hi',mercury=[sys.executable,'-c',script])\n  try: await task.outcome\n  except error: pass\n  else: raise AssertionError(error)\n  await task.exit\n try: await run('hi',mercury='mercury-sdk-no-such-binary-proof')\n except MercurySpawnError: pass\n else: raise AssertionError('spawn')\n async with await start_fixture_server({'methods':{'initialize':[{'result':{'protocol':1,'runner':{'version':'fixture','pid':1},'session_id':'s'}}],'session/set_mode':[{'error':{'code':-32010,'message':'no mode','data':{'kind':'mode'}}}]}}) as server:\n  async with await connect(mercury=[*server.mercury,'run']) as session:\n   try: await session.set_mode('wrong')\n   except MercuryRefusal as error: assert error.code==-32010\n   else: raise AssertionError('refusal')\n print('PASS Python five errors and command-prefix handling')\nasyncio.run(main())\n`
  writeFileSync(join(scratch, 'errors.py'), code)
  const child = spawn('python3', [join(scratch, 'errors.py')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(resolve(import.meta.dir, '../..'), 'sdk-py/src') }, stdio: 'inherit' })
  assert.equal(await new Promise(r => child.once('close', r)), 0)
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log('PASS typed errors, invalid params, command prefixes and host ask cancellation')
