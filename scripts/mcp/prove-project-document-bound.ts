#!/usr/bin/env bun
// gate-watch: src/services/mcp/config.ts src/services/mcp/client.ts src/cli/handlers/mcp.tsx
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-document-bound-')))
const home = join(root, 'home')
const cwd = join(root, 'project')
const dist = resolve(import.meta.dir, '../../dist/mercury.mjs')
mkdirSync(home, { recursive: true })
mkdirSync(join(cwd, '.mercury'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_MCP_CONNECTION_BATCH
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const entries = (count: number, command = '/usr/bin/true', args = ['x'.repeat(200)], env?: Record<string, string>): Record<string, { command: string; args: string[]; env?: Record<string, string> }> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`server-${String(index).padStart(4, '0')}`, { command, args, ...(env === undefined ? {} : { env }) }]))
const projectFile = join(cwd, '.mercury', 'mcp.json')
const documentLine = `MCP file ${projectFile}: 2,000 servers, the first 64 loaded`
seedFirstRun(home, [cwd])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ kit: { trustProjectServers: true } }))
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', BROWSER: '/usr/bin/true', MERCURY_MCP_TIMEOUT_MS: '1000' }
  delete env.MERCURY_HOME
  delete env.MERCURY_MCP_CONNECTION_BATCH
  delete env.NODE_ENV
  return env
}
const list = (): { status: number | null; output: string; elapsed: number } => {
  const started = Date.now()
  const result = spawnSync(process.env.MERCURY_NODE ?? 'node', [dist, 'mcp', 'list'], { cwd, env: childEnv(), encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, elapsed: Date.now() - started }
}

try {
  check('the built CLI exists for the mcp list fixture', existsSync(dist), dist)
  const { parseMcpConfig } = await import('../../src/services/mcp/config.ts')
  const large = parseMcpConfig({ configObject: { mcpServers: entries(2000) }, expandVars: false, scope: 'project', filePath: projectFile })
  check('a 2,000-entry document keeps its first 64 entries', Object.keys(large.config?.mcpServers ?? {}).length === 64, String(Object.keys(large.config?.mcpServers ?? {}).length))
  check('the kept entries are in file order', Object.keys(large.config?.mcpServers ?? {})[63] === 'server-0063' && !('server-0064' in (large.config?.mcpServers ?? {})))
  check('the parse carries the document line once', large.notices?.filter(line => line === documentLine).length === 1, JSON.stringify(large.notices))
  const small = parseMcpConfig({ configObject: { mcpServers: entries(10) }, expandVars: false, scope: 'project', filePath: projectFile })
  check('a 10-entry document keeps every entry and adds no line', Object.keys(small.config?.mcpServers ?? {}).length === 10 && small.notices?.length === 0, JSON.stringify(small.notices))
  const user = parseMcpConfig({ configObject: { mcpServers: entries(65) }, expandVars: false, scope: 'user' })
  check('the inline user map stays uncapped', Object.keys(user.config?.mcpServers ?? {}).length === 65 && user.notices?.length === 0, String(Object.keys(user.config?.mcpServers ?? {}).length))

  writeFileSync(projectFile, JSON.stringify({ mcpServers: entries(2000) }))
  const largeList = list()
  const largeRows = largeList.output.match(/^server-\d{4}:/gm) ?? []
  console.log(`mcp list 2,000 entries: rc=${largeList.status} rows=${largeRows.length} elapsed=${largeList.elapsed}ms`)
  check('mcp list succeeds for the large document', largeList.status === 0, largeList.output.slice(-500))
  check('mcp list loads only 64 servers', largeRows.length === 64, String(largeRows.length))
  check('mcp list prints the document line once', largeList.output.split('\n').filter(line => line === documentLine).length === 1, largeList.output.slice(0, 500))
  check('mcp list finishes under five seconds', largeList.elapsed < 5000, `${largeList.elapsed}ms`)

  writeFileSync(projectFile, JSON.stringify({ mcpServers: entries(10) }))
  const smallList = list()
  const smallRows = smallList.output.match(/^server-\d{4}:/gm) ?? []
  check('mcp list keeps all 10 small-document servers', smallList.status === 0 && smallRows.length === 10, `${smallList.status} rows=${smallRows.length}`)
  check('mcp list prints no document line for 10 servers', !smallList.output.includes('servers, the first 64 loaded'), smallList.output.slice(0, 500))

  const overlapLog = join(root, 'overlap.jsonl')
  writeFileSync(overlapLog, '')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { getMcpToolsCommandsAndResources, clearServerCache } = await import('../../src/services/mcp/client.ts')
  const concurrency = Object.fromEntries(Object.entries(entries(10, process.execPath, [join(import.meta.dir, '_fixture-document-concurrency.mjs'), overlapLog])).map(([name, config]) => [name, { ...config, scope: 'local' as const }]))
  await getMcpToolsCommandsAndResources(() => {}, concurrency)
  await new Promise(resolve => setTimeout(resolve, 500))
  for (const [name, config] of Object.entries(concurrency)) await clearServerCache(name, config)
  const events = readFileSync(overlapLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; pid: number; at: number })
  const starts = new Map<number, number>()
  const intervals: Array<{ start: number; end: number }> = []
  for (const event of events) {
    if (event.type === 'start') starts.set(event.pid, event.at)
    else if (starts.has(event.pid)) intervals.push({ start: starts.get(event.pid)!, end: event.at })
  }
  let active = 0
  let maximum = 0
  const points = intervals.flatMap(interval => [{ at: interval.start, delta: 1 }, { at: interval.end, delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta)
  for (const point of points) {
    active += point.delta
    maximum = Math.max(maximum, active)
  }
  console.log(`mcp list concurrency: processes=${intervals.length} maximum overlap=${maximum}`)
  check('the scripted servers record real overlap', intervals.length === 10 && maximum > 1, JSON.stringify({ processes: intervals.length, maximum, output: smallList.output.slice(-2000) }))
  check('the existing local probe limiter bounds overlap at three', maximum <= 3, String(maximum))
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(failures === 0 ? 'PROJECT DOCUMENT BOUND GREEN' : `${failures} PROJECT DOCUMENT BOUND FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
