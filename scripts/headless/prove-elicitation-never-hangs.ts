#!/usr/bin/env bun
// gate-watch: src/cli/print.ts src/cli/headless/runnerAsks.ts src/runner/wire/* src/services/mcp/client.ts scripts/mcp/_fixture-estate-server.mjs
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg !== -1 && process.argv[distArg + 1] ? resolve(process.argv[distArg + 1]!) : join(ROOT, 'dist', 'mercury.mjs')
const FIXTURE = join(ROOT, 'scripts', 'mcp', '_fixture-estate-server.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const guarded = async (body: () => Promise<void>): Promise<void> => {
  try {
    await body()
  } catch (error) {
    check('the section ran to its end', false, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}

if (!existsSync(DIST)) {
  console.log(`❌ ${DIST} absent — build first`)
  process.exit(1)
}
const node = Bun.which('node')
if (node === null) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}
console.log(`an MCP server's question on a hosted session never hangs the turn — ${DIST}`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the elicitation proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const BOUND_MS = 60_000

function world(name: string): { scratch: ReturnType<typeof scratchHome>; mcp: string } {
  const scratch = scratchHome(`elicit-${name}-`)
  const mcp = join(scratch.home, 'estate.mcp.json')
  writeFileSync(mcp, JSON.stringify({ mcpServers: { estate: { command: node, args: [FIXTURE] } } }))
  return { scratch, mcp }
}

const turns = () => [
  { kind: 'tool_use' as const, name: 'mcp__estate__ask', input: {}, preText: 'asking the server' },
  { kind: 'text' as const, text: 'the server answered' },
]

const resultText = (row: Record<string, unknown> | undefined): string => (row === undefined ? '' : typeof row.output === 'string' ? row.output : j(row.output ?? ''))

section('§1 a host that declares no elicitation (the daemon): the question is answered cancel at once, the editor is never asked, the turn goes on within the bound')
await guarded(async () => {
  const { scratch, mcp } = world('daemon')
  const api = await startFixtureApi(turns())
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000', MERCURY_MCP_CALL_IDLE_MINUTES: '0.5' }, argv: ['--model', 'claude-opus-4-8', '--mode', 'sovereign', '--mcp', mcp, '--only-mcp'] })
  await host.initialize({ holds_asks: true, elicitation: false }, 90_000)
  const t0 = Date.now()
  await host.prompt('ask the server')
  const result = await host.waitFor('the tool result', row => row.type === 'tool_result', BOUND_MS)
  const waited = Date.now() - t0
  check(`the tool result lands within the bound (${waited} ms of ${BOUND_MS})`, waited < BOUND_MS)
  check('the server got the cancel answer', resultText(result).includes('"action":"cancel"'), resultText(result).slice(0, 200))
  check('the host was never asked', host.elicitations.length === 0, j(host.elicitations))
  const outcome = await host.waitFor('the outcome', row => row.type === 'outcome', BOUND_MS)
  check('the turn completes', outcome.status === 'completed', j(outcome))
  await host.stop()
  await api.close()
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
})

section('§2 a host that declares elicitation: the question crosses as elicitation/request with the message and the schema; its answer reaches the server')
await guarded(async () => {
  const { scratch, mcp } = world('face')
  const api = await startFixtureApi(turns())
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000', MERCURY_MCP_CALL_IDLE_MINUTES: '0.5' }, argv: ['--model', 'claude-opus-4-8', '--mode', 'sovereign', '--mcp', mcp, '--only-mcp'] })
  host.onElicitation(() => ({ action: 'accept', content: { colour: 'blue' } }))
  await host.initialize({ holds_asks: true, elicitation: true }, 90_000)
  await host.prompt('ask the server')
  const result = await host.waitFor('the tool result', row => row.type === 'tool_result', BOUND_MS)
  check('the question reached the host once, naming the server, the message and the schema', host.elicitations.length === 1 && host.elicitations[0]!.params.server === 'estate' && host.elicitations[0]!.params.message === 'What is your favourite colour?' && typeof host.elicitations[0]!.params.schema === 'object', j(host.elicitations))
  check("the host's answer reached the server: accept and the colour", resultText(result).includes('"action":"accept"') && resultText(result).includes('"colour":"blue"'), resultText(result).slice(0, 200))
  const outcome = await host.waitFor('the outcome', row => row.type === 'outcome', BOUND_MS)
  check('the turn completes', outcome.status === 'completed', j(outcome))
  await host.stop()
  await api.close()
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
})

console.log('')
if (failures > 0) {
  console.log(`❌ elicitation never hangs: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log("✅ elicitation never hangs: a hosted session answers an MCP server's question at once when its host cannot, and hands it over when it can")
