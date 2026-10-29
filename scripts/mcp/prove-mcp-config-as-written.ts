#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, PROBE_KEY, SCRATCH_ROOT, childEnv, configKeyOf, makeTally } from '../daemon/dupline-world.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { parseFrame, type Frame } from '../lib/rows.ts'

const SCRATCH = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'mcp-config-as-written-')))
const TOKEN = 'hunter2-fixture-token-4b9e1c'
const REFERENCE = '${env:R3_SECRET}'
const tally = makeTally('prove-mcp-config-as-written')

if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST} — build first; this proof drives the artifact`)
  process.exit(1)
}

const home = join(SCRATCH, 'home')
const project = join(SCRATCH, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(join(project, '.mercury'), { recursive: true })
const markers = join(home, 'markers')
mkdirSync(markers, { recursive: true })
const answering = join(SCRATCH, 'answering.cjs')
const silent = join(SCRATCH, 'silent.cjs')
writeFileSync(
  answering,
  `require('node:fs').writeFileSync(process.argv[2], process.argv.slice(3).join(' '));
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const q = JSON.parse(line);
  if (q.id === undefined) return;
  const result = q.method === 'initialize'
    ? { protocolVersion: q.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'answers', version: '1' } }
    : q.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');
});
`,
)
writeFileSync(silent, `require('node:fs').writeFileSync(process.argv[2], process.argv.slice(3).join(' ')); setInterval(() => {}, 1000)`)
writeFileSync(
  join(home, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [configKeyOf(realpathSync(project))]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }),
)
writeFileSync(join(home, 'settings.json'), JSON.stringify({ kit: { trustProjectServers: true } }))
writeFileSync(
  join(project, '.mercury', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      answers: { type: 'stdio', command: process.execPath, args: [answering, join(markers, 'answers.txt'), `--token=${REFERENCE}`] },
      hangs: { type: 'stdio', command: process.execPath, args: [silent, join(markers, 'hangs.txt'), `--token=${REFERENCE}`] },
      remote: { type: 'http', url: `http://127.0.0.1:1/${REFERENCE}/mcp` },
    },
  }),
)

const env = { ...childEnv(home, 1), MERCURY_MCP_TIMEOUT_MS: '2000', R3_SECRET: TOKEN }

function mcp(...args: string[]): { rc: number | null; out: string } {
  const result = spawnSync(NODE, [DIST, 'mcp', ...args], { cwd: realpathSync(project), env, encoding: 'utf8', timeout: 120_000 })
  return { rc: result.status, out: `${result.stdout}${result.stderr}` }
}

type Turn = { rows: Frame[]; stdout: string; stderr: string; exitCode: number | null }

async function run(): Promise<Turn> {
  const api = await startFixtureApi([{ kind: 'text', text: 'The as-written turn completed.' }])
  try {
    return await new Promise<Turn>(resolveTurn => {
      const port = Number(new URL(api.url).port)
      const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', MODEL, '--', 'say hi'], {
        cwd: realpathSync(project),
        env: { ...childEnv(home, port), MERCURY_MCP_TIMEOUT_MS: '2000', R3_SECRET: TOKEN },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let pending = ''
      let stderr = ''
      const rows: Frame[] = []
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
      child.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stdout += text
        pending += text
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
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
        resolveTurn({ rows, stdout, stderr, exitCode: code })
      })
    })
  } finally {
    await api.close()
  }
}

const marker = (name: string): string => {
  const path = join(markers, `${name}.txt`)
  return existsSync(path) ? readFileSync(path, 'utf8') : 'ABSENT'
}
const clearMarkers = (): void => {
  for (const name of ['answers', 'hangs']) rmSync(join(markers, `${name}.txt`), { force: true })
}
function filesCarrying(dir: string, needle: string): string[] {
  const hits: string[] = []
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(full)
      else if (info.isFile() && readFileSync(full, 'latin1').includes(needle)) hits.push(full)
    }
  }
  walk(dir)
  return hits
}

try {
  tally.section('§1 mcp get: a connected stdio server prints its arguments as written; the server itself received the value')
  {
    const got = mcp('get', 'answers')
    console.log(`  rc=${got.rc} · ${JSON.stringify(got.out.trim().split('\n').slice(0, 6))}`)
    tally.check('exit 0 with Status connected', got.rc === 0 && got.out.includes('Status: ● connected'), got.out.slice(0, 400))
    tally.check('the Args line shows the reference as written', got.out.includes(`--token=${REFERENCE}`), got.out.slice(0, 400))
    tally.check('the token appears nowhere in the output', !got.out.includes(TOKEN), got.out.slice(0, 400))
    tally.check('the server received the expanded value (the marker carries the token)', marker('answers').includes(`--token=${TOKEN}`), marker('answers'))
  }

  tally.section('§2 mcp get: the connect deadline names the command it spawned as written')
  {
    const got = mcp('get', 'hangs')
    console.log(`  rc=${got.rc} · ${JSON.stringify(got.out.trim().split('\n').slice(0, 3))}`)
    tally.check('the deadline sentence carries the spawned command with the reference as written', /did not answer in 2s/.test(got.out) && got.out.includes(`--token=${REFERENCE}`), got.out.slice(0, 500))
    tally.check('the token appears nowhere in the output', !got.out.includes(TOKEN), got.out.slice(0, 500))
    tally.check('the server received the expanded value', marker('hangs').includes(`--token=${TOKEN}`), marker('hangs'))
  }

  tally.section('§3 mcp get: a remote server prints its URL as written')
  {
    const got = mcp('get', 'remote')
    console.log(`  rc=${got.rc} · ${JSON.stringify(got.out.trim().split('\n').slice(0, 5))}`)
    tally.check('the URL line shows the reference as written', got.out.includes(`URL: http://127.0.0.1:1/${REFERENCE}/mcp`), got.out.slice(0, 500))
    tally.check('the token appears nowhere in the output', !got.out.includes(TOKEN), got.out.slice(0, 500))
  }

  tally.section('§4 mcp list: every row as written')
  {
    clearMarkers()
    const listed = mcp('list')
    const rows = listed.out.trim().split('\n').filter(line => /^(answers|hangs|remote):/.test(line))
    console.log(`  rc=${listed.rc} · ${JSON.stringify(rows)}`)
    tally.check('the three rows print', rows.length === 3, listed.out.slice(0, 600))
    tally.check('the stdio rows carry the reference as written', rows.filter(row => row.includes(`--token=${REFERENCE}`)).length === 2, JSON.stringify(rows))
    tally.check('the remote row carries the URL as written', rows.some(row => row.includes(`http://127.0.0.1:1/${REFERENCE}/mcp`)), JSON.stringify(rows))
    tally.check('the token appears nowhere in the output', !listed.out.includes(TOKEN), listed.out.slice(0, 600))
    tally.check('both stdio servers received the expanded value', marker('answers').includes(TOKEN) && marker('hangs').includes(TOKEN), `${marker('answers')} · ${marker('hangs')}`)
  }

  tally.section('§5 a headless run: the notice rows and stderr name the server as written')
  {
    clearMarkers()
    const turn = await run()
    const notices = turn.rows.filter(row => row.type === 'notice') as Array<{ text?: string; code?: string }>
    console.log(`  rows: ${turn.rows.map(row => String(row.type)).join(' ')} (exit ${turn.exitCode ?? '?'})`)
    console.log(`  notices: ${notices.map(notice => `[${notice.code ?? '-'}] ${notice.text ?? ''}`).join(' | ')}`)
    tally.check('the run reached an outcome', turn.rows.some(row => row.type === 'outcome'), JSON.stringify({ exit: turn.exitCode, stderr: turn.stderr.slice(-300) }))
    const hangsNotice = notices.find(notice => (notice.text ?? '').startsWith('MCP server `hangs` did not start'))
    tally.check('the notice for the server that never answered names the spawned command as written', hangsNotice !== undefined && (hangsNotice.text ?? '').includes(`--token=${REFERENCE}`), JSON.stringify(hangsNotice))
    tally.check('the token appears in no row and nowhere on stderr', !turn.stdout.includes(TOKEN) && !turn.stderr.includes(TOKEN), `${turn.stdout.slice(0, 300)} ${turn.stderr.slice(0, 300)}`)
    tally.check('both stdio servers received the expanded value', marker('answers').includes(TOKEN) && marker('hangs').includes(TOKEN), `${marker('answers')} · ${marker('hangs')}`)
  }

  tally.section('§6 nothing the product wrote under its home carries the value: no log, no record, no transcript')
  {
    const hits = filesCarrying(home, TOKEN).filter(path => !path.startsWith(markers))
    tally.check('only the markers the servers wrote carry the token', hits.length === 0, JSON.stringify(hits))
  }

  tally.section('§7 in process: the parsed record keeps the written strings beside the expanded ones')
  {
    process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'in-process-home')
    mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
    process.env.R3_SECRET = TOKEN
    const { parseMcpConfig } = await import('../../src/services/mcp/config.js')
    const { mcpConfigAsWritten, getLoggingSafeMcpBaseUrl, describeMcpConnectFailure } = await import('../../src/services/mcp/utils.js')
    const parsed = parseMcpConfig({
      configObject: {
        mcpServers: {
          answers: { type: 'stdio', command: 'node', args: ['server.js', `--token=${REFERENCE}`], env: { KEY: REFERENCE } },
          plain: { type: 'stdio', command: 'node', args: ['server.js'] },
          remote: { type: 'http', url: `https://api.example.test/${REFERENCE}/mcp?key=${REFERENCE}` },
        },
      },
      expandVars: true,
      scope: 'project',
    })
    const servers = parsed.config?.mcpServers ?? {}
    const answers = servers.answers as { args?: string[]; env?: Record<string, string>; unexpanded?: { command?: string; args?: string[] } }
    tally.check('the expanded args carry the value', (answers.args ?? []).includes(`--token=${TOKEN}`) && answers.env?.KEY === TOKEN, JSON.stringify(answers))
    tally.check('the record keeps the args as written, and only the fields an expansion changed', JSON.stringify(answers.unexpanded) === JSON.stringify({ args: ['server.js', `--token=${REFERENCE}`] }), JSON.stringify(answers.unexpanded))
    tally.check('a config without references carries no written copy', (servers.plain as { unexpanded?: unknown }).unexpanded === undefined, JSON.stringify(servers.plain))
    const remote = servers.remote as { url?: string; unexpanded?: { url?: string } }
    tally.check('the remote record keeps the URL as written', remote.url === `https://api.example.test/${TOKEN}/mcp?key=${TOKEN}` && remote.unexpanded?.url === `https://api.example.test/${REFERENCE}/mcp?key=${REFERENCE}`, JSON.stringify(remote))
    tally.check('mcpConfigAsWritten answers the written strings', JSON.stringify(mcpConfigAsWritten(servers.answers!)) === JSON.stringify({ command: 'node', args: ['server.js', `--token=${REFERENCE}`] }) && mcpConfigAsWritten(servers.remote!).url === remote.unexpanded?.url)
    const safe = getLoggingSafeMcpBaseUrl(servers.remote!) ?? ''
    tally.check('the logging-safe base URL reads the URL as written', safe.includes('api.example.test') && !safe.includes(TOKEN), safe)
    const refused = describeMcpConnectFailure(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), { transport: 'stdio', command: mcpConfigAsWritten(servers.answers!).command })
    tally.check('the spawn sentence names the command as written', refused.startsWith('command not found: node'), refused)
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

tally.finish()
