#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')
const mock2 = path.join(repo, 'scripts/dap/mock-dap-adapter-2.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — breadth proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const scratch = mkdtempSync(path.join(tmpdir(), 'dap-breadth-'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'dap-breadth-home-'))
const adaptersFile = path.join(scratch, 'dap-adapters.json')
writeFileSync(
  adaptersFile,
  JSON.stringify({
    mock2: {
      command: process.execPath,
      args: [mock2],
      fileTypes: ['.m2'],
      rootMarkers: ['mock2.toml'],
      attachShape: 'flat',
      attachDefaults: { flavor: 'file-row' },
    },
    mock2tcp: {
      command: process.execPath,
      args: [mock2, '${port}'],
      connect: 'tcp',
      fileTypes: ['.m2t'],
    },
    mock2connect: {
      command: process.execPath,
      args: [mock2],
      attachShape: 'connect',
    },
  }),
)
process.env.MERCURY_DAP_ADAPTERS_FILE = adaptersFile

const { resolveAdapter, knownAdapterKeys, adapterKeyForExtension, createDapSession, removeDapSession, _dapSessionCountForTesting } =
  await import('../../src/services/dap/dapClient.ts')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const owner = processMainOwner()

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function runOp(input: Record<string, unknown>) {
  const result = await (DebugTool as { call: Function }).call(input, {
    owner,
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: {} }),
  })
  return result as { data: { result: string; outcome: string; debuggee?: string } }
}

console.log('— A. the adapter config file —')
{
  const row = resolveAdapter('mock2')
  check('file row resolves', row !== null && row.command === process.execPath && row.attachShape === 'flat', JSON.stringify(row))
  check('file rows list in knownAdapterKeys', knownAdapterKeys().includes('mock2') && knownAdapterKeys().includes('mock2tcp'))
  check('extension auto-pick reads the file table', adapterKeyForExtension('.m2') === 'mock2' && adapterKeyForExtension('.m2t') === 'mock2tcp')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ mock2: { command: '/env/wins', args: [] } })
  const overridden = resolveAdapter('mock2')
  check('the env table outranks the file table', overridden?.command === '/env/wins', JSON.stringify(overridden))
  delete process.env.MERCURY_DAP_ADAPTERS
  check('builtins still resolve beside the file', resolveAdapter('lldb') !== null)
}

console.log('— A2. project adapters follow the project trust grant —')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  const trust = await import('../../src/utils/config/trust.ts')
  const bootstrap = await import('../../src/bootstrap/state.ts')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const debug = await import('../../src/utils/debug.ts')
  const { isMercuryConfigSegment } = await import('../../src/utils/permissions/filesystem.ts')
  check('project adapter files are protected executable configuration', isMercuryConfigSegment('dap-adapters.json'))
  enableConfigs()
  debug.enableDebugLogging()
  delete process.env.MERCURY_DAP_ADAPTERS_FILE
  const userFile = path.join(process.env.MERCURY_CONFIG_DIR!, 'dap-adapters.json')
  writeFileSync(userFile, JSON.stringify({ shared: { command: '/user/adapter' } }))
  const project = path.join(scratch, 'project')
  mkdirSync(path.join(project, '.mercury'), { recursive: true })
  const projectFile = path.join(project, '.mercury', 'dap-adapters.json')
  const projectRows = {
    projectMock: { command: process.execPath, args: [mock2], fileTypes: ['.project-dap'] },
    shared: { command: '/project/adapter' },
  }
  writeFileSync(projectFile, JSON.stringify(projectRows))
  bootstrap.setIsInteractive(false)
  bootstrap.setSessionTrustAccepted(false)
  trust.resetTrustDialogAcceptedCacheForTesting()
  await runWithCwdOverride(project, async () => {
    check('an untrusted project file contributes no adapters', !trust.checkHasTrustDialogAccepted() && resolveAdapter('projectMock') === null && !knownAdapterKeys().includes('projectMock'))
    check('the user adapter remains available without project trust', resolveAdapter('shared')?.command === '/user/adapter')
    trust.setPathTrusted(project)
    check('the trusted project file is loaded and its extensions resolve', resolveAdapter('projectMock')?.command === process.execPath && knownAdapterKeys().includes('projectMock') && adapterKeyForExtension('.project-dap') === 'projectMock')
    check('the project adapter overrides the user row', resolveAdapter('shared')?.command === '/project/adapter')
    const other = path.join(scratch, 'untrusted-other')
    mkdirSync(path.join(other, '.mercury'), { recursive: true })
    writeFileSync(path.join(other, '.mercury', 'dap-adapters.json'), JSON.stringify({ foreign: { command: '/foreign/adapter' } }))
    check('trust does not leak into another working directory', runWithCwdOverride(other, () => resolveAdapter('foreign')) === null)
    process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ shared: { command: '/env/adapter' } })
    check('an explicit environment row overrides the project', resolveAdapter('shared')?.command === '/env/adapter')
    delete process.env.MERCURY_DAP_ADAPTERS
    const allowed = bootstrap.getAllowedSettingSources()
    bootstrap.setAllowedSettingSources(['userSettings'])
    check('disabled project settings do not load project adapters', resolveAdapter('projectMock') === null && resolveAdapter('shared')?.command === '/user/adapter')
    bootstrap.setAllowedSettingSources(allowed)
    await debug.flushDebugLogs()
    const log = (await import('node:fs')).existsSync(debug.getDebugLogPath()) ? readFileSync(debug.getDebugLogPath(), 'utf8') : ''
    check('the trusted load names its file in the existing debug log', log.includes(projectFile) && log.includes('trusted project'))
    const program = path.join(project, 'program.project-dap')
    writeFileSync(program, 'fixture\n')
    const launch = await runOp({ op: 'launch', adapter: 'projectMock', program, file: program, lines: [3], session: 'project' })
    check('a trusted project adapter drives a real DAP stop', launch.data.debuggee === 'stopped', launch.data.result)
    await runOp({ op: 'disconnect', session: 'project' })
    writeFileSync(projectFile, '{broken')
    check('a malformed project file falls back without replacing user rows', resolveAdapter('shared')?.command === '/user/adapter' && resolveAdapter('projectMock') === null)
  })
  bootstrap.setSessionTrustAccepted(false)
  trust.resetTrustDialogAcceptedCacheForTesting()
  process.env.MERCURY_DAP_ADAPTERS_FILE = adaptersFile
}

console.log('— P. attach by port/host —')
{
  const r = await runOp({ op: 'attach', adapter: 'mock2', port: 45_678, host: '10.0.0.9', session: 'att' })
  check('attach-by-port succeeded with a typed stop', /attached to 10\.0\.0\.9:45678/.test(r.data.result) && r.data.debuggee === 'stopped', r.data.result.slice(0, 200))
  const echo = await runOp({ op: 'customRequest', session: 'att', method: 'mock/lastAttach' })
  check('the FLAT attach body carried port + host + the file-row defaults', /"port": 45678/.test(echo.data.result) && /"host": "10\.0\.0\.9"/.test(echo.data.result) && /"flavor": "file-row"/.test(echo.data.result), echo.data.result.slice(0, 300))
  await runOp({ op: 'disconnect', session: 'att' })

  const listenPort = await freePort()
  const listening = spawn(process.execPath, [mock2, String(listenPort)], { stdio: 'ignore' })
  let r2 = await runOp({ op: 'attach', adapter: 'mock2connect', port: listenPort, session: 'att2' })
  for (const until = Date.now() + 10_000; Date.now() < until && /nothing is listening at/.test(r2.data.result); ) {
    await new Promise(r => setTimeout(r, 100))
    r2 = await runOp({ op: 'attach', adapter: 'mock2connect', port: listenPort, session: 'att2' })
  }
  check('connect-shaped attach succeeded — the attach dialed the listening program instead of starting an adapter', r2.data.debuggee === 'stopped', r2.data.result.slice(0, 160))
  const echo2 = await runOp({ op: 'customRequest', session: 'att2', method: 'mock/lastAttach' })
  check('the debugpy spelling nests {connect:{host,port}}', /"connect": \{/.test(echo2.data.result) && new RegExp(`"port": ${listenPort}`).test(echo2.data.result), echo2.data.result.slice(0, 300))
  await runOp({ op: 'disconnect', session: 'att2' })
  if (listening.exitCode === null) listening.kill('SIGKILL')
  const idlePort = await freePort()
  const r3 = await runOp({ op: 'attach', adapter: 'mock2connect', port: idlePort, session: 'att3' })
  check('a connect-shaped attach with nothing listening refuses at once in one line naming the dial', r3.data.outcome === 'failed' && new RegExp(`^attach failed: nothing is listening at 127\\.0\\.0\\.1:${idlePort} \\(ECONNREFUSED\\) — start the program`).test(r3.data.result), r3.data.result.slice(0, 220))

  const perm = await (DebugTool as { checkPermissions: Function }).checkPermissions({ op: 'attach', port: 5005 })
  check('a bare-port attach auto-picks the python adapter at the gate', perm.behavior === 'passthrough' && /adapter python/.test(perm.message), JSON.stringify(perm))
}

console.log('— T. tcp connect with a substituted port —')
{
  const program = path.join(scratch, 'demo.m2t')
  writeFileSync(program, 'x\n')
  const r = await runOp({ op: 'launch', program, file: program, lines: [3], session: 'tcp' })
  check('tcp launch reached the first stop over the socket', r.data.debuggee === 'stopped' && /via mock2tcp/.test(r.data.result), r.data.result.slice(0, 220))
  const argv = await runOp({ op: 'customRequest', session: 'tcp', method: 'mock/argv' })
  const portMatch = argv.data.result.match(/"(\d{2,5})"/)
  check('the adapter received a REAL substituted port, not the token', portMatch !== null && Number(portMatch![1]) > 0 && !argv.data.result.includes('${port}'), argv.data.result.slice(0, 200))
  await runOp({ op: 'disconnect', session: 'tcp' })
}

console.log('— C. conditional-breakpoint honesty —')
{
  const program = path.join(scratch, 'demo2.m2')
  writeFileSync(program, 'x\n')
  await runOp({ op: 'launch', program, session: 'cond', file: program, lines: [1] })
  const good = await runOp({ op: 'breakpoints', session: 'cond', file: program, breakpoints: [{ line: 4, condition: 'x == 4' }] })
  check('a parseable condition VERIFIES', /line 4: verified/.test(good.data.result), good.data.result.slice(0, 160))
  const bad = await runOp({ op: 'breakpoints', session: 'cond', file: program, breakpoints: [{ line: 5, condition: 'garbage(' }] })
  check("an unparseable condition is UNVERIFIED with the adapter's reason", /line 5: UNVERIFIED \(unparseable condition/.test(bad.data.result), bad.data.result.slice(0, 200))
  const hit = await runOp({ op: 'breakpoints', session: 'cond', file: program, breakpoints: [{ line: 6, hitCondition: '3' }] })
  check('the unadvertised hit-count feature refuses PRECISELY before sending', /does not support hit-count breakpoints/.test(hit.data.result), hit.data.result.slice(0, 200))
  await runOp({ op: 'disconnect', session: 'cond' })
}

console.log('— S. the still-running NORMAL result —')
{
  process.env.MOCK2_NEVER_STOP = '1'
  const program = path.join(scratch, 'demo3.m2')
  writeFileSync(program, 'x\n')
  await runOp({ op: 'launch', program, session: 'run' })
  const r = await runOp({ op: 'continue', session: 'run' })
  check('a never-stopping continue returns still-running (succeeded, debuggee running)', r.data.outcome === 'succeeded' && r.data.debuggee === 'running' && /still running after 10s/.test(r.data.result), `${r.data.outcome}/${r.data.debuggee}: ${r.data.result.slice(0, 160)}`)
  await runOp({ op: 'disconnect', session: 'run' })
  delete process.env.MOCK2_NEVER_STOP
}

console.log('— X. customRequest round-trips raw —')
{
  const program = path.join(scratch, 'demo4.m2')
  writeFileSync(program, 'x\n')
  await runOp({ op: 'launch', program, session: 'x' })
  const r = await runOp({ op: 'customRequest', session: 'x', method: 'mock/echo', body: JSON.stringify({ hello: [1, 2] }) })
  check('the echo carries the body verbatim', /"hello": \[\s*1,\s*2\s*\]/.test(r.data.result), r.data.result.slice(0, 200))
  const badBody = await runOp({ op: 'customRequest', session: 'x', method: 'mock/echo', body: '{nope' })
  check('malformed body JSON refuses typed', badBody.data.outcome === 'failed' && /not valid JSON/.test(badBody.data.result))
  await runOp({ op: 'disconnect', session: 'x' })
}

check('no sessions leaked', _dapSessionCountForTesting() === 0, String(_dapSessionCountForTesting()))
console.log('')
if (failures > 0) {
  console.log(`RED: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('GREEN: attach/tcp/config-file/conditional/still-running/customRequest all hold')
