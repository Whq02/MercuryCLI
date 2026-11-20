import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const rootScratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn27-')))
const scratchHome = join(rootScratch, 'home')
mkdirSync(scratchHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

function runIsolated(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'fn27-iso-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const SRC = ${JSON.stringify(SRC)}
    const SCRATCH = ${JSON.stringify(scratch)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
      timeout: 30_000,
    })
    if (res.status !== 0) throw new Error(`isolated failed (rc ${res.status}): ${res.stderr.slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

try {
  {
    const { prepareApply } = await import(join(SRC, 'tools/LSPTool/mercuryOps/prepare.ts'))
    const dir = join(rootScratch, 'prepare-case')
    mkdirSync(dir, { recursive: true })
    const fileAsParent = join(dir, 'blocker')
    writeFileSync(fileAsParent, 'not a dir')
    const blockedPath = join(fileAsParent, 'child.ts')
    const env = { cwd: dir, absolutePath: blockedPath, manager: {}, input: {}, tool: {}, context: {} } as never
    const res = await prepareApply(
      env,
      async () => ({ documentChanges: [{ kind: 'create', uri: pathToFileURL(blockedPath).href }] }),
      { allowCreate: true },
    )
    check(
      'prepare-create-non-enoent: ENOTDIR from stat refuses create instead of treating path as absent',
      res.ok === false && !res.reason.includes('already exists') && /ENOTDIR|not a directory|could not/i.test(res.reason),
      JSON.stringify(res),
    )
    if (POSIX_MODES) {
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      const hidden = join(locked, 'new.ts')
      chmodSync(locked, 0o000)
      try {
        const resAcc = await prepareApply(
          env,
          async () => ({ documentChanges: [{ kind: 'create', uri: pathToFileURL(hidden).href }] }),
          { allowCreate: true },
        )
        check(
          'prepare-create-non-enoent: EACCES from stat refuses create instead of treating path as absent',
          resAcc.ok === false && !resAcc.reason.includes('already exists') && /EACCES|permission denied|could not/i.test(resAcc.reason),
          JSON.stringify(resAcc),
        )
      } finally {
        chmodSync(locked, 0o700)
      }
    }
  }

  {
    const r = runIsolated(`
      const { ListMcpResourcesTool } = await import(SRC + '/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts')
      const { tellMcpToolsTheClient } = await import(SRC + '/services/mcp/client/forTools.ts')
      tellMcpToolsTheClient({
        ensureConnectedClient: async client => {
          if (client.name === 'broken') throw new Error('MCP server "broken" is not connected')
          return client
        },
        fetchResourcesForClient: async client => [{ uri: 'file:///ok', name: 'ok', server: client.name }],
        reconnectMcpServerImpl: async () => { throw new Error('unused') },
      })
      const ctx = {
        options: {
          mcpClients: [
            { type: 'connected', name: 'broken' },
            { type: 'connected', name: 'healthy' },
          ],
        },
      }
      try {
        await ListMcpResourcesTool.call({ server: 'broken' }, ctx)
        out.namedThrew = false
      } catch (e) {
        out.namedThrew = true
        out.namedMessage = e instanceof Error ? e.message : String(e)
      }
      const all = await ListMcpResourcesTool.call({}, ctx)
      out.allCount = all.data.length
      out.allServer = all.data[0]?.server ?? null
    `)
    check(
      'list-mcp-resources-named-server-throws: querying a named server whose reconnect fails throws instead of answering empty',
      r.namedThrew === true && String(r.namedMessage ?? '').includes('not connected'),
      JSON.stringify(r),
    )
    check(
      'list-mcp-resources-named-server-throws: querying all servers still returns healthy sibling resources',
      r.allCount === 1 && r.allServer === 'healthy',
      JSON.stringify(r),
    )
  }

  {
    const r = runIsolated(`
      const { mock } = await import('bun:test')
      const stateMod = await import(SRC + '/bootstrap/state.ts')
      mock.module(SRC + '/bootstrap/state.ts', () => ({
        ...stateMod,
        getSessionId: () => { throw new Error('broken-session-state') },
      }))
      mock.module(SRC + '/bootstrap/state.js', () => ({
        ...stateMod,
        getSessionId: () => { throw new Error('broken-session-state') },
      }))
      const { RetainTool } = await import(SRC + '/tools/MemoryTools/MemoryTools.ts')
      const ctx = {
        messages: [{ type: 'user', message: { role: 'user', content: 'please remember that the build uses bun' } }],
        abortController: new AbortController(),
        getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
        setAppState: () => {},
      }
      try {
        await RetainTool.call({ items: [{ content: 'fact about repo' }] }, ctx)
        out.threw = false
      } catch (e) {
        out.threw = true
        out.message = e instanceof Error ? e.message : String(e)
      }
    `)
    check(
      'memory-tools-session-id-throws: RetainTool propagates getSessionId error instead of filing under boot',
      r.threw === true && String(r.message ?? '').includes('broken-session-state'),
      JSON.stringify(r),
    )
  }

  {
    const r = runIsolated(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { mock } = await import('bun:test')
      const stopMod = await import(SRC + '/tasks/stopTask.ts')
      mock.module(SRC + '/tasks/stopTask.ts', () => ({
        ...stopMod,
        stopTask: async () => { throw new Error('stopTask-refused') },
      }))
      mock.module(SRC + '/tasks/stopTask.js', () => ({
        ...stopMod,
        stopTask: async () => { throw new Error('stopTask-refused') },
      }))
      const { MonitorTool } = await import(SRC + '/tools/MonitorTool/MonitorTool.ts')
      const pidFile = path.join(SCRATCH, 'mon.pid')
      let state = { tasks: {}, toolPermissionContext: { mode: 'default' } }
      const ctx = {
        abortController: new AbortController(),
        toolUseId: 'mon-test-1',
        getAppState: () => state,
        setAppState: updater => { state = updater(state) },
      }
      await MonitorTool.call({
        command: 'echo $$ > ' + JSON.stringify(pidFile) + ' && exec sleep 30',
        description: 'leak-check',
        timeout_ms: 1000,
        persistent: false,
      }, ctx)
      const deadline = Date.now() + 3000
      let pid = 0
      while (Date.now() < deadline) {
        if (fs.existsSync(pidFile)) {
          const parsed = Number(fs.readFileSync(pidFile, 'utf8').trim())
          if (Number.isInteger(parsed) && parsed > 0) { pid = parsed; break }
        }
        await Bun.sleep(50)
      }
      await Bun.sleep(1600)
      let alive = false
      if (pid > 0) {
        try {
          process.kill(pid, 0)
          alive = true
          try { process.kill(pid, 'SIGKILL') } catch {}
        } catch {
          alive = false
        }
      }
      out.pid = pid
      out.aliveAfterExpiry = alive
    `)
    check(
      'monitor-stop-fallback-kills-process: when stopTask fails on expiry, MonitorTool kills shellCommand directly instead of leaking the process',
      Number(r.pid) > 0 && r.aliveAfterExpiry === false,
      JSON.stringify(r),
    )
  }

  {
    const r = runIsolated(`
      const { mock } = await import('bun:test')
      const pathsMod = await import(SRC + '/utils/sessionStorage/paths.ts')
      const launchMod = await import(SRC + '/tasks/LocalAgentTask/launchReceipts.ts')
      let failPath = false
      mock.module(SRC + '/utils/sessionStorage/paths.ts', () => ({
        ...pathsMod,
        getAgentTranscriptPath: id => {
          if (failPath) throw new Error('bad-transcript-path')
          return pathsMod.getAgentTranscriptPath(id)
        },
      }))
      mock.module(SRC + '/utils/sessionStorage/paths.js', () => ({
        ...pathsMod,
        getAgentTranscriptPath: id => {
          if (failPath) throw new Error('bad-transcript-path')
          return pathsMod.getAgentTranscriptPath(id)
        },
      }))
      mock.module(SRC + '/tasks/LocalAgentTask/launchReceipts.ts', () => ({
        ...launchMod,
        recordedLaunchesNamed: async () => { throw new Error('launch-read-failed') },
        recordedNamedLaunches: async () => { throw new Error('launch-list-failed') },
      }))
      mock.module(SRC + '/tasks/LocalAgentTask/launchReceipts.js', () => ({
        ...launchMod,
        recordedLaunchesNamed: async () => { throw new Error('launch-read-failed') },
        recordedNamedLaunches: async () => { throw new Error('launch-list-failed') },
      }))
      const { resolveCrewAddress, unknownAgentRefusal } = await import(SRC + '/tools/SendMessageTool/crewAddress.ts')
      const ctx = {
        messages: [],
        getAppState: () => ({ tasks: {}, agentNameRegistry: new Map() }),
      }
      failPath = true
      try {
        await resolveCrewAddress('a12345678', ctx)
        out.pathThrew = false
      } catch (e) {
        out.pathThrew = true
        out.pathMessage = e instanceof Error ? e.message : String(e)
      }
      failPath = false
      try {
        await resolveCrewAddress('worker-one', ctx)
        out.namedThrew = false
      } catch (e) {
        out.namedThrew = true
        out.namedMessage = e instanceof Error ? e.message : String(e)
      }
      try {
        await unknownAgentRefusal('worker-one', ctx, 'deliver to')
        out.knownThrew = false
      } catch (e) {
        out.knownThrew = true
        out.knownMessage = e instanceof Error ? e.message : String(e)
      }
    `)
    check(
      'crew-address-path-throws: resolveCrewAddress propagates getAgentTranscriptPath bug instead of returning unknown',
      r.pathThrew === true && String(r.pathMessage ?? '').includes('bad-transcript-path'),
      JSON.stringify(r),
    )
    check(
      'crew-address-recorded-named-throws: resolveCrewAddress propagates recordedLaunchesNamed failure instead of returning unknown',
      r.namedThrew === true && String(r.namedMessage ?? '').includes('launch-read-failed'),
      JSON.stringify(r),
    )
    check(
      'crew-address-known-launched-throws: unknownAgentRefusal propagates recordedNamedLaunches failure instead of claiming an incomplete list is complete',
      r.knownThrew === true && String(r.knownMessage ?? '').includes('launch-list-failed'),
      JSON.stringify(r),
    )
  }

  {
    const r = runIsolated(`
      const { ToolSearchTool } = await import(SRC + '/tools/ToolSearchTool/ToolSearchTool.ts')
      const makeTool = (name, hint, isEnabled) => ({
        name,
        shouldDefer: true,
        searchHint: hint,
        isEnabled,
        description: async () => hint,
        prompt: async () => hint,
        inputSchema: {},
        call: async () => ({ data: {} }),
      })
      const tools = [
        makeTool('alpha_broken', 'alpha widget tool', () => { throw new Error('enable-check-failed') }),
        makeTool('beta_healthy', 'alpha helper', () => true),
      ]
      const ctx = {
        messages: [],
        options: { tools, engineModel: 'claude-opus-4-8' },
        getAppState: () => ({ toolPermissionContext: { mode: 'default' }, mcp: { clients: [] } }),
      }
      const res = await ToolSearchTool.call({ query: 'alpha', max_results: 2 }, ctx)
      out.matches = res.data.matches
    `)
    const matches = (r.matches as string[] | undefined) ?? []
    check(
      'tool-search-probe-enabled-fails-closed: a tool whose isEnabled throws is treated as disabled and ranks after enabled tools',
      matches[0] === 'beta_healthy',
      JSON.stringify(r),
    )
  }
} finally {
  rmSync(rootScratch, { recursive: true, force: true })
}

void runIsolated
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
