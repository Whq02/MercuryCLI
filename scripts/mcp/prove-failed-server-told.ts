#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { parseFrame, type Frame } from '../lib/rows.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-failed-server-told')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'failed-server-told-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const DEADLINE_MS = 1500
const project = join(scratch, 'proj')
const runHome = join(scratch, 'run-home')
seedScratchHome(runHome, project)
writeFileSync(join(runHome, 'settings.json'), JSON.stringify({ kit: { trustProjectServers: true } }))
const exitScript = 'console.error("boom: the config file is missing"); process.exit(3)'
const hangScript = 'setInterval(() => {}, 1000)'
mkdirSync(join(project, '.mercury'), { recursive: true })
writeFileSync(
  join(project, '.mercury', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      exits: { type: 'stdio', command: process.execPath, args: ['-e', exitScript] },
      hangs: { type: 'stdio', command: process.execPath, args: ['-e', hangScript] },
    },
  }),
)
const ASK = 'what tools do you have'
const systemNotes: string[] = []
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  for (const text of req.allTexts) if (text.includes('MCP server `') && !systemNotes.includes(text)) systemNotes.push(text)
  if (req.step === 0) return [{ type: 'tool_use', name: 'ContextLeft', input: {} }]
  return [{ type: 'text', text: 'read what I was told' }]
})

type Turn = { rows: Frame[]; stderr: string; exitCode: number | null }
const runOnce = (cwd: string, extraEnv: Record<string, string>): Promise<Turn> =>
  new Promise(resolve => {
    const port = Number(new URL(fixture.base).port)
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', MODEL, '--', ASK], { cwd, env: { ...childEnv(runHome, port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const rows: Frame[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const frame = parseFrame(line)
        if (frame !== null) rows.push(frame)
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ rows, stderr, exitCode: code })
    })
  })

let turn: Turn
try {
  turn = await runOnce(project, { MERCURY_MCP_TIMEOUT_MS: String(DEADLINE_MS) })
} finally {
  await fixture.close()
}
const session = turn.rows.find(row => row.type === 'session') as { mcp_servers?: Array<{ name: string; status: string }> } | undefined
const notices = turn.rows.filter(row => row.type === 'notice') as Array<{ text?: string; code?: string }>
const failedNotices = notices.filter(notice => notice.code === 'mcp_server_failed')
const noticeFor = (name: string): string => failedNotices.find(notice => (notice.text ?? '').startsWith(`MCP server \`${name}\` did not start`))?.text ?? ''
console.log(`── rows: ${turn.rows.map(row => String(row.type)).join(' ')} (exit ${turn.exitCode ?? '?'}) ──`)
console.log(`── notices ──\n${notices.map(notice => `│ [${notice.code ?? '-'}] ${notice.text ?? ''}`).join('\n')}`)
console.log(`── system notes the model read ──\n${systemNotes.map(text => `│ ${text.replace(/\n/g, '\n│ ')}`).join('\n')}`)
console.log(`── stderr ──\n${turn.stderr.trim().split('\n').map(line => `│ ${line}`).join('\n')}`)

tally.section('§1 a server that exits at once and a server that never answers are both told to the operator — once each, with the reason')
tally.check('the run reached an outcome', turn.rows.some(row => row.type === 'outcome'), JSON.stringify({ exit: turn.exitCode, stderr: turn.stderr.slice(-300) }))
const statuses = Object.fromEntries((session?.mcp_servers ?? []).map(s => [s.name, s.status]))
tally.check('the session row carries both servers: the one that exited reads failed, the one that never answered reads failed or still pending at that instant', statuses.exits === 'failed' && (statuses.hangs === 'failed' || statuses.hangs === 'pending'), JSON.stringify(session?.mcp_servers))
tally.check('one notice row names the server that exited, with its stderr words', failedNotices.filter(notice => (notice.text ?? '').startsWith('MCP server `exits` did not start')).length === 1 && noticeFor('exits').includes('boom: the config file is missing') && noticeFor('exits').includes('its tools are not available this session'), noticeFor('exits'))
tally.check('one notice row names the server that never answered, with the deadline, the command it spawned and that stderr was silent', failedNotices.filter(notice => (notice.text ?? '').startsWith('MCP server `hangs` did not start')).length === 1 && noticeFor('hangs').includes('did not answer in 1.5s') && noticeFor('hangs').includes(`spawned ${process.execPath} -e ${hangScript}`) && noticeFor('hangs').includes('nothing on stderr'), noticeFor('hangs'))
tally.check('stderr carries both lines once each', turn.stderr.split('\n').filter(line => line.includes('MCP server `exits` did not start')).length === 1 && turn.stderr.split('\n').filter(line => line.includes('MCP server `hangs` did not start')).length === 1, turn.stderr.slice(-600))

tally.section('§2 the model is told the same, once, in a system note it can act on')
const note = systemNotes.join('\n')
tally.check('the model read a note naming the server that exited and why', /MCP server `exits` did not start: .*boom: the config file is missing.*its tools are not available this session/.test(note), note.slice(0, 500))
tally.check('…and the server that never answered, with the spawned command', /MCP server `hangs` did not start: .*did not answer in 1\.5s.*spawned /.test(note), note.slice(0, 500))
tally.check('each server is named once in what the model read', (note.match(/MCP server `exits` did not start/g) ?? []).length === 1 && (note.match(/MCP server `hangs` did not start/g) ?? []).length === 1, note.slice(0, 500))

tally.section('§3 an untrusted folder with a .mercury/mcp.json: mcp list and the readiness row say the trust reason, never "no servers configured"')
const untrusted = join(scratch, 'untrusted')
mkdirSync(join(untrusted, '.mercury'), { recursive: true })
writeFileSync(join(untrusted, '.mercury', 'mcp.json'), JSON.stringify({ mcpServers: { quiet: { type: 'stdio', command: process.execPath, args: ['-e', hangScript] } } }))
const env = { ...childEnv(runHome, 1), MERCURY_MCP_TIMEOUT_MS: String(DEADLINE_MS) }
const list = spawnSync(NODE, [DIST, 'mcp', 'list'], { cwd: untrusted, env, encoding: 'utf8', timeout: 120_000 })
const listOut = `${list.stdout}${list.stderr}`
console.log(`── mcp list (untrusted) ──\n${listOut.trim().split('\n').map(line => `│ ${line}`).join('\n')}`)
tally.check('mcp list says the folder is not trusted and how many project servers were left unloaded', listOut.includes('mcp: this folder is not trusted, so its 1 project MCP server was not loaded from .mercury/mcp.json') && listOut.includes('accept the trust card'), listOut.slice(0, 400))
tally.check('mcp list no longer claims that no MCP servers are configured', !listOut.includes('No MCP servers configured'), listOut.slice(0, 400))
const health = spawnSync(NODE, [DIST, 'health', '--json'], { cwd: untrusted, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
let mcpNone: { detail?: string; remedy?: string; source?: string } | undefined
try {
  const parsed = JSON.parse(health.stdout) as { readiness?: Array<{ id: string; detail?: string; remedy?: string; source?: string }> }
  mcpNone = (parsed.readiness ?? []).find(record => record.id === 'mcp:none')
} catch {
  mcpNone = undefined
}
tally.check('the readiness row for MCP says the trust reason and the remedy', mcpNone !== undefined && (mcpNone.detail ?? '').includes('this folder is not trusted') && (mcpNone.remedy ?? '').includes('accept the trust card') && mcpNone.source === '.mercury/mcp.json', JSON.stringify(mcpNone ?? health.stderr.slice(-300)))

rmSync(scratch, { recursive: true, force: true })
tally.finish()
