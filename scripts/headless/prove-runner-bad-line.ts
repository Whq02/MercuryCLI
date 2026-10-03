#!/usr/bin/env bun
// gate-watch: src/cli/print.ts src/runner/wire/* src/cli/headless/runnerMethods.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'
import { RPC_INVALID_REQUEST, RPC_PARSE_ERROR } from '../../src/runner/wire/errors.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at !== -1 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') !== undefined ? resolve(argAfter('--dist')!) : join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

if (!existsSync(DIST)) {
  console.log(`❌ ${DIST} absent — build first`)
  process.exit(1)
}
const node = Bun.which('node')
if (node === null) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}
console.log(`a bad line on stdin — ${DIST} through the runner door`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const api = await startFixtureApi([{ kind: 'text', text: 'BAD-LINE-ONE.' }, { kind: 'text', text: 'BAD-LINE-TWO.' }])

{
  section('§1 one unreadable line answers -32700 with id null; a batch -32600; the runner serves the next request')
  {
    const scratch = scratchHome('runner-bad-line-')
    const raw: string[] = []
    const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }, argv: ['--model', 'claude-opus-4-8'], raw: chunk => raw.push(chunk) })
    try {
      await host.initialize({}, 90_000)
      const responsesBefore = raw.join('').split('\n').filter(line => line.includes('"error"')).length
      host.child.stdin!.write('this is not json\n')
      host.child.stdin!.write('[{"jsonrpc":"2.0","id":9,"method":"session/facts","params":{}}]\n')
      await new Promise(resolve => setTimeout(resolve, 300))
      const errors = raw
        .join('')
        .split('\n')
        .filter(line => line.includes('"error"'))
        .slice(responsesBefore)
        .map(line => JSON.parse(line) as { id: unknown; error: { code: number; message: string } })
      check('the unreadable line is answered -32700 with id null and the runner stays up', errors.some(e => e.id === null && e.error.code === RPC_PARSE_ERROR) && host.child.exitCode === null, j(errors))
      check('a batch is answered -32600 (one message per line)', errors.some(e => e.id === null && e.error.code === RPC_INVALID_REQUEST && /batch/.test(e.error.message)), j(errors))
      const facts = await host.request('session/facts', {}, 30_000)
      check('the next request is served', typeof facts.model === 'object', j(Object.keys(facts)))
      const added = await host.prompt('say one')
      const outcome = await host.waitFor('the outcome', row => row.type === 'outcome', 60_000)
      check('a turn runs after the bad lines', added.accepted === true && outcome.status === 'completed' && outcome.answer === 'BAD-LINE-ONE.', j(outcome))
    } catch (error) {
      check('the runner door served the proof', false, error instanceof Error ? error.message : String(error))
    }
    const code = await host.stop()
    check('closing stdin ends the runner cleanly', code === 0, `exit=${code} stderr=${host.stderr().slice(0, 300)}`)
    rmSync(scratch.home, { recursive: true, force: true })
    rmSync(scratch.cwd, { recursive: true, force: true })
  }

  section('§2 three consecutive unreadable lines are a stream out of step: one stderr line, exit 1')
  {
    const scratch = scratchHome('runner-bad-line-')
    const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }, argv: ['--model', 'claude-opus-4-8'] })
    try {
      await host.initialize({}, 90_000)
      host.child.stdin!.write('one\ntwo\nthree\n')
      const timer = setTimeout(() => host.child.kill('SIGKILL'), 20_000)
      const code = await host.exited
      clearTimeout(timer)
      check('the runner exits 1', code === 1, `exit=${code}`)
      check('stderr names the out-of-step stream and the count', /3 consecutive unreadable lines/.test(host.stderr()) && /out of step/.test(host.stderr()), host.stderr().slice(0, 300))
    } catch (error) {
      check('the runner door served the proof', false, error instanceof Error ? error.message : String(error))
      await host.stop()
    }
    host.peer.close('done')
    rmSync(scratch.home, { recursive: true, force: true })
    rmSync(scratch.cwd, { recursive: true, force: true })
  }
}
await api.close()

console.log('')
if (failures > 0) {
  console.log(`❌ runner bad line: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ runner bad line: a bad line is answered, never fatal; a stream out of step ends loudly')
