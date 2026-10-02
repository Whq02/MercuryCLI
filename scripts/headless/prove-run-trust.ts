#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
for (const trusted of [false, true]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-trust-')))
  const home = join(root, 'home'), cwd = join(root, 'workspace')
  mkdirSync(home)
  mkdirSync(cwd)
  mkdirSync(join(cwd, '.mercury'))
  seedFirstRun(home, trusted ? [cwd] : [])
  writeFileSync(join(cwd, 'MERCURY.md'), 'PROJECT_INSTRUCTION_MARKER: answer with a concise sentence.\n')
  const hookMark = join(root, 'hook-ran'), mcpMark = join(root, 'mcp-ran')
  const hookScript = join(root, 'hook.cjs'), serverScript = join(root, 'server.cjs')
  writeFileSync(hookScript, `require('node:fs').writeFileSync(${JSON.stringify(hookMark)}, 'yes')`)
  writeFileSync(serverScript, `require('node:fs').writeFileSync(${JSON.stringify(mcpMark)}, 'yes'); const r = require('node:readline').createInterface({input:process.stdin}); r.on('line', line => { const q = JSON.parse(line); if (q.id === undefined) return; const result = q.method === 'initialize' ? {protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'trust-fixture',version:'1'}} : q.method === 'tools/list' ? {tools:[]} : {}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n'); });`)
  writeFileSync(join(cwd, '.mercury/settings.json'), JSON.stringify({ events: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(hookScript)}` }] }] } } }))
  writeFileSync(join(cwd, '.mercury', 'mcp.json'), JSON.stringify({ mcpServers: { trustFixture: { command: 'node', args: [serverScript] } } }))
  const api = await startFixtureApi([{ kind: 'text', text: 'The trust turn completed.' }])
  const child = spawn('node', [dist, 'run', 'answer the trust fixture'], { cwd, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(root, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', data => { out += data })
  child.stderr.on('data', data => { err += data })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  try {
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))
    check(`${trusted ? 'trusted' : 'untrusted'} run completes without a trust prompt`, code === 0 && out.trim() === 'The trust turn completed.', JSON.stringify({ code, out, err }))
    const instructions = JSON.stringify(api.messageRequests().map(request => request.body)).includes('PROJECT_INSTRUCTION_MARKER')
    check(`${trusted ? 'trusted' : 'untrusted'} project instructions follow the trust grant`, instructions === trusted, String(instructions))
    check(`${trusted ? 'trusted' : 'untrusted'} project hooks follow the trust grant`, existsSync(hookMark) === trusted)
    check(`${trusted ? 'trusted' : 'untrusted'} project MCP follows the trust grant`, existsSync(mcpMark) === trusted)
  } finally {
    clearTimeout(timer)
    await api.close()
    rmSync(root, { recursive: true, force: true })
  }
}
process.exit(failures === 0 ? 0 : 1)
