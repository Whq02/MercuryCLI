import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const FN27_FIX_HINTS: Array<[string, string]> = [
  ['prepare-create-non-enoent', 'fix prepareApply in src/tools/lsp/mercury-ops/prepare.ts so a stat error other than ENOENT refuses the create with the real error, and is not read as the path being absent'],
  ['list-mcp-resources-named-server-throws', 'fix ListMcpResourcesTool.call in src/tools/list-mcp-resources/ListMcpResourcesTool.ts so a named server whose reconnect fails throws, while a query over all servers still returns the healthy ones'],
  ['memory-tools-session-id-throws', 'fix RetainTool in src/tools/memory/MemoryTools.ts so an error from getSessionId propagates and the fact is not filed under boot'],
  ['monitor-stop-fallback-kills-process', 'fix MonitorTool in src/tools/monitor/MonitorTool.ts so when stopTask fails on expiry it kills the shell command directly'],
  ['crew-address-', 'fix resolveCrewAddress and unknownAgentRefusal in src/tools/send-message/crewAddress.ts so a failing transcript-path or launch-receipt read propagates and is not answered as unknown'],
  ['tool-search-probe-enabled-fails-closed', 'fix ToolSearchTool in src/tools/tool-search/ToolSearchTool.ts so a tool whose isEnabled throws counts as disabled and ranks after enabled tools'],
  ['video-tool-inline-read-failure-noted', 'fix mapToolResultToToolResultBlockParam in src/tools/video/VideoTool.tsx so an inline preview that cannot be read adds the preview-unavailable note'],
  ['shell-directory-non-enoent', 'fix exec in src/platform/shell/shellExec.ts so a cwd error other than ENOENT reports the real error, and only a missing folder says Path does not exist'],
  ['shell-kept-directory-', 'fix exec and getShellCwd in src/platform/shell/shellExec.ts so a kept directory that cannot be entered or no longer exists runs the command in the start folder and says so once'],
  ['scoped-credential-read-throws', 'fix readAccountOAuthCreds in src/models/sign-in/account-ledger/scopedCredentialRead.ts so a storage read failure propagates and only absent credentials return undefined'],
  ['account-identity-read-error-unverified', 'fix resolveLiveScopeIdentity in src/models/sign-in/account-ledger/accountIdentity.ts so a readCreds that throws returns unverified with the saved email and is not cached'],
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const fix = cond ? undefined : FN27_FIX_HINTS.find(([prefix]) => label.startsWith(prefix))?.[1]
  const shown = !cond && (detail || fix) ? ` — ${[detail, fix].filter(Boolean).join(' | ')}` : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown}`)
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
    const dir = join(rootScratch, 'prepare-case')
    mkdirSync(dir, { recursive: true })
    const fileAsParent = join(dir, 'blocker')
    writeFileSync(fileAsParent, 'not a dir')
    const blockedPath = join(fileAsParent, 'child.ts')
    let res: { ok: boolean; reason?: string }
    if (process.platform === 'win32') {
      const r = runIsolated(`
        const { mock } = await import('bun:test')
        const { pathToFileURL } = await import('node:url')
        const realFsp = await import('node:fs/promises')
        const blockedPath = ${JSON.stringify(blockedPath)}
        mock.module('node:fs/promises', () => ({
          ...realFsp,
          stat: async (p, ...rest) => {
            if (String(p) === blockedPath) throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' })
            return realFsp.stat(p, ...rest)
          },
        }))
        const { prepareApply } = await import(SRC + '/tools/lsp/mercury-ops/prepare.ts')
        const env = { cwd: ${JSON.stringify(dir)}, absolutePath: blockedPath, manager: {}, input: {}, tool: {}, context: {} }
        out.res = await prepareApply(
          env,
          async () => ({ documentChanges: [{ kind: 'create', uri: pathToFileURL(blockedPath).href }] }),
          { allowCreate: true },
        )
      `)
      res = r.res as { ok: boolean; reason?: string }
    } else {
      const { prepareApply } = await import(join(SRC, 'tools/lsp/mercury-ops/prepare.ts'))
      const env = { cwd: dir, absolutePath: blockedPath, manager: {}, input: {}, tool: {}, context: {} } as never
      res = await prepareApply(
        env,
        async () => ({ documentChanges: [{ kind: 'create', uri: pathToFileURL(blockedPath).href }] }),
        { allowCreate: true },
      )
    }
    check(
      'prepare-create-non-enoent: ENOTDIR from stat refuses create instead of treating path as absent',
      res.ok === false && !(res.reason ?? '').includes('already exists') && /ENOTDIR|not a directory|could not/i.test(res.reason ?? ''),
      JSON.stringify(res),
    )
    if (POSIX_MODES) {
      const { prepareApply } = await import(join(SRC, 'tools/lsp/mercury-ops/prepare.ts'))
      const env = { cwd: dir, absolutePath: blockedPath, manager: {}, input: {}, tool: {}, context: {} } as never
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
      const { ListMcpResourcesTool } = await import(SRC + '/tools/list-mcp-resources/ListMcpResourcesTool.ts')
      const { getEmptyToolPermissionContext } = await import(SRC + '/tools/kit/tool.ts')
      const { tellMcpToolsTheClient } = await import(SRC + '/integrations/mcp/client/forTools.ts')
      tellMcpToolsTheClient({
        ensureConnectedClient: async client => {
          if (client.name === 'broken') throw new Error('MCP server "broken" is not connected')
          return client
        },
        fetchResourcesForClient: async client => [{ uri: 'file:///ok', name: 'ok', server: client.name }],
        reconnectMcpServerImpl: async () => { throw new Error('unused') },
      })
      const ctx = {
        getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
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
      const stateMod = await import(SRC + '/boot/process-state/processState.ts')
      mock.module(SRC + '/boot/process-state/processState.ts', () => ({
        ...stateMod,
        getSessionId: () => { throw new Error('broken-session-state') },
      }))
      mock.module(SRC + '/boot/process-state/processState.js', () => ({
        ...stateMod,
        getSessionId: () => { throw new Error('broken-session-state') },
      }))
      const { RetainTool } = await import(SRC + '/tools/memory/MemoryTools.ts')
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
      const stopMod = await import(SRC + '/engine/tasks/stopTask.ts')
      mock.module(SRC + '/engine/tasks/stopTask.ts', () => ({
        ...stopMod,
        stopTask: async () => { throw new Error('stopTask-refused') },
      }))
      mock.module(SRC + '/engine/tasks/stopTask.js', () => ({
        ...stopMod,
        stopTask: async () => { throw new Error('stopTask-refused') },
      }))
      const { MonitorTool } = await import(SRC + '/tools/monitor/MonitorTool.ts')
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
      const pathsMod = await import(SRC + '/sessions/transcripts/paths.ts')
      const launchMod = await import(SRC + '/engine/tasks/local-agent/launchReceipts.ts')
      let failPath = false
      mock.module(SRC + '/sessions/transcripts/paths.ts', () => ({
        ...pathsMod,
        getCrewmateTranscriptPath: id => {
          if (failPath) throw new Error('bad-transcript-path')
          return pathsMod.getCrewmateTranscriptPath(id)
        },
      }))
      mock.module(SRC + '/sessions/transcripts/paths.js', () => ({
        ...pathsMod,
        getCrewmateTranscriptPath: id => {
          if (failPath) throw new Error('bad-transcript-path')
          return pathsMod.getCrewmateTranscriptPath(id)
        },
      }))
      mock.module(SRC + '/engine/tasks/local-agent/launchReceipts.ts', () => ({
        ...launchMod,
        recordedLaunchesNamed: async () => { throw new Error('launch-read-failed') },
        recordedNamedLaunches: async () => { throw new Error('launch-list-failed') },
      }))
      mock.module(SRC + '/engine/tasks/local-agent/launchReceipts.js', () => ({
        ...launchMod,
        recordedLaunchesNamed: async () => { throw new Error('launch-read-failed') },
        recordedNamedLaunches: async () => { throw new Error('launch-list-failed') },
      }))
      const { resolveCrewAddress, unknownCrewmateRefusal } = await import(SRC + '/tools/send-message/crewAddress.ts')
      const ctx = {
        messages: [],
        getAppState: () => ({ tasks: {}, crewmateNameRegistry: new Map() }),
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
        await unknownCrewmateRefusal('worker-one', ctx, 'deliver to')
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
      const { ToolSearchTool } = await import(SRC + '/tools/tool-search/ToolSearchTool.ts')
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

  {
    const r = runIsolated(`
      const path = await import('node:path')
      process.env.MERCURY_MODEL = 'claude-opus-4-8'
      const { VideoTool } = await import(SRC + '/tools/video/VideoTool.tsx')
      const mapped = VideoTool.mapToolResultToToolResultBlockParam(
        {
          outcome: 'succeeded',
          result: 'Saved video to videos/clip.mp4',
          path: 'videos/clip.mp4',
          framePath: 'videos/clip.png',
          inlinePath: path.join(SCRATCH, 'missing-preview.png.inline'),
          inlineMediaType: 'image/png',
          jobId: 'job-1',
          duration: 5,
        },
        'video-use-1',
      )
      out.content = mapped.content
    `)
    check(
      'video-tool-inline-read-failure-noted: missing inline preview appends the preview-unavailable note instead of silently omitting the image',
      typeof r.content === 'string' && r.content.includes('Preview could not be prepared for the model; open the saved frame.'),
      JSON.stringify(r),
    )
  }

  {
    const r = runIsolated(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const blocker = path.join(SCRATCH, 'not-a-dir')
      fs.writeFileSync(blocker, 'file')
      const notDirChild = path.join(blocker, 'sub')
      if (process.platform === 'win32') {
        const { mock } = await import('bun:test')
        const realFs = await import('node:fs')
        mock.module('node:fs', () => ({
          ...realFs,
          realpathSync: Object.assign(
            (p, opts) => {
              if (String(p) === notDirChild) throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' })
              return realFs.realpathSync(p, opts)
            },
            { native: realFs.realpathSync.native },
          ),
        }))
      }
      const { exec } = await import(SRC + '/platform/shell/shellExec.ts')
      const enotdirCmd = await exec('echo hi', new AbortController().signal, 'bash', { cwd: notDirChild })
      const enotdirRes = await enotdirCmd.result
      out.enotdirErr = enotdirRes.preSpawnError ?? ''
      const missingPath = path.join(SCRATCH, 'genuinely-absent')
      const missingCmd = await exec('echo hi', new AbortController().signal, 'bash', { cwd: missingPath })
      const missingRes = await missingCmd.result
      out.missingErr = missingRes.preSpawnError ?? ''
      const posix = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
      out.posix = posix
      if (posix) {
        const locked = path.join(SCRATCH, 'locked-dir')
        fs.mkdirSync(locked)
        const hidden = path.join(locked, 'sub')
        fs.mkdirSync(hidden)
        fs.chmodSync(locked, 0o000)
        try {
          const eaccesCmd = await exec('echo hi', new AbortController().signal, 'bash', { cwd: hidden })
          const eaccesRes = await eaccesCmd.result
          out.eaccesErr = eaccesRes.preSpawnError ?? ''
        } finally {
          fs.chmodSync(locked, 0o700)
        }
      }
    `)
    const enotdirErr = String(r.enotdirErr ?? '')
    const missingErr = String(r.missingErr ?? '')
    check(
      'shell-directory-non-enoent: ENOTDIR cwd reports real error instead of claiming Path does not exist',
      !enotdirErr.includes('does not exist') && /ENOTDIR|not a directory/i.test(enotdirErr),
      JSON.stringify(r),
    )
    check(
      'shell-directory-non-enoent: genuinely absent cwd still reports Path does not exist',
      missingErr.includes('does not exist'),
      JSON.stringify(r),
    )
    if (r.posix === true) {
      const eaccesErr = String(r.eaccesErr ?? '')
      check(
        'shell-directory-non-enoent: EACCES cwd reports real permission error instead of claiming Path does not exist',
        !eaccesErr.includes('does not exist') && /EACCES|permission denied/i.test(eaccesErr),
        JSON.stringify(r),
      )
    }
  }

  if (!POSIX_MODES) {
    console.log(`  [SKIP] shell-kept-directory-unenterable — not read ${process.platform === 'win32' ? 'on Windows' : 'as root'}: a POSIX mode does not lock a folder ${process.platform === 'win32' ? 'there' : 'for uid 0'}`)
  } else {
    const r = runIsolated(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const state = await import(SRC + '/boot/process-state/processState.ts')
      state.setOriginalCwd(PROJECT)
      state.setCwdState(PROJECT)
      const { exec, getShellCwd } = await import(SRC + '/platform/shell/shellExec.ts')
      const run = async (command, options) => {
        const result = await (await exec(command, new AbortController().signal, 'bash', options ?? {})).result
        return { code: result.code, stdout: result.stdout, stderr: result.stderr, preSpawnError: result.preSpawnError ?? '' }
      }
      const outer = path.join(PROJECT, 'outer')
      const inner = path.join(outer, 'inner')
      fs.mkdirSync(inner, { recursive: true })
      out.project = PROJECT
      out.inner = inner
      out.entered = await run('cd outer/inner')
      out.keptAfterCd = getShellCwd()
      fs.chmodSync(outer, 0o000)
      try {
        out.first = await run('pwd -P')
        out.second = await run('pwd -P')
        out.named = await run('pwd -P', { cwd: inner })
      } finally {
        fs.chmodSync(outer, 0o700)
      }
      out.back = await run('cd outer/inner && pwd -P')
      out.keptAtEnd = getShellCwd()
      fs.rmSync(inner, { recursive: true, force: true })
      out.gone = await run('pwd -P')
      out.afterGone = await run('pwd -P')
    `)
    type Ran = { code?: number; stdout?: string; stderr?: string; preSpawnError?: string }
    const project = String(r.project ?? '')
    const inner = String(r.inner ?? '')
    const entered = (r.entered ?? {}) as Ran
    const first = (r.first ?? {}) as Ran
    const second = (r.second ?? {}) as Ran
    const named = (r.named ?? {}) as Ran
    const back = (r.back ?? {}) as Ran
    const gone = (r.gone ?? {}) as Ran
    const afterGone = (r.afterGone ?? {}) as Ran
    const moved = `The shell's directory is now ${project}: ${inner} could not be entered (`
    const times = (text: string | undefined, part: string): number => (text ?? '').split(part).length - 1
    check(
      'shell-kept-directory-unenterable: control, a cd is kept for the next command',
      entered.code === 0 && r.keptAfterCd === inner,
      JSON.stringify(r),
    )
    check(
      'shell-kept-directory-unenterable: a plain command runs in the start folder and says once where the shell is now',
      first.code === 0 && (first.stdout ?? '').trim() === project && times(first.stderr, moved) === 1 && times(first.stderr, "The shell's directory is now") === 1,
      JSON.stringify(r),
    )
    check(
      'shell-kept-directory-unenterable: the next plain command runs there and carries no sentence',
      second.code === 0 && (second.stdout ?? '').trim() === project && times(second.stderr, "The shell's directory is now") === 0,
      JSON.stringify(r),
    )
    check(
      'shell-kept-directory-unenterable: a call that names the locked folder as its cwd still fails with the error',
      named.code !== 0 && /EACCES|permission denied/i.test(named.preSpawnError ?? '') && !(named.preSpawnError ?? '').includes('does not exist'),
      JSON.stringify(r),
    )
    check(
      'shell-kept-directory-unenterable: the folder unlocked again, a cd into it works and is kept',
      back.code === 0 && (back.stdout ?? '').trim() === inner && r.keptAtEnd === inner,
      JSON.stringify(r),
    )
    check(
      'shell-kept-directory-missing: a plain command runs in the start folder and says once that the folder no longer exists',
      gone.code === 0 && (gone.stdout ?? '').trim() === project && times(gone.stderr, `The shell's directory is now ${project}: ${inner} no longer exists.`) === 1 && times(afterGone.stderr, "The shell's directory is now") === 0 && afterGone.code === 0,
      JSON.stringify(r),
    )
  }

  {
    const r = runIsolated(`
      const { mock } = await import('bun:test')
      const storageMod = await import(SRC + '/platform/secure-storage/index.ts')
      let mode = 'throw'
      const fakeStorage = {
        ...storageMod,
        getSecureStorage: () => ({
          name: 'fake',
          read: () => {
            if (mode === 'throw') throw new Error('EACCES: keychain locked')
            return null
          },
          readAsync: async () => null,
          update: () => ({ success: false }),
          delete: () => false,
        }),
      }
      mock.module(SRC + '/platform/secure-storage/index.ts', () => fakeStorage)
      mock.module(SRC + '/platform/secure-storage/index.js', () => fakeStorage)
      const { readAccountOAuthCreds } = await import(SRC + '/models/sign-in/account-ledger/scopedCredentialRead.ts')
      try {
        readAccountOAuthCreds(HOME)
        out.threw = false
      } catch (e) {
        out.threw = true
        out.message = e instanceof Error ? e.message : String(e)
      }
      mode = 'null'
      out.absentResult = readAccountOAuthCreds(HOME) ?? null
    `)
    check(
      'scoped-credential-read-throws: readAccountOAuthCreds propagates storage read failure instead of returning undefined',
      r.threw === true && String(r.message ?? '').includes('keychain locked'),
      JSON.stringify(r),
    )
    check(
      'scoped-credential-read-throws: absent credentials still return undefined',
      r.absentResult === null,
      JSON.stringify(r),
    )
  }

  {
    const r = runIsolated(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { resolveLiveScopeIdentity, _resetIdentityCacheForTesting } = await import(SRC + '/models/sign-in/account-ledger/accountIdentity.ts')
      const scopeDir = path.join(SCRATCH, 'scope-a')
      fs.mkdirSync(scopeDir, { recursive: true })
      fs.writeFileSync(path.join(scopeDir, '.mercury.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-1', emailAddress: 'saved@example.com' } }))
      _resetIdentityCacheForTesting()
      const first = await resolveLiveScopeIdentity(scopeDir, {
        readCreds: () => { throw new Error('EACCES: keychain locked') },
      })
      const second = await resolveLiveScopeIdentity(scopeDir, {
        readCreds: () => undefined,
      })
      out.first = first
      out.second = second
    `)
    const first = r.first as { state?: string; email?: string; note?: string } | undefined
    const second = r.second as { state?: string } | undefined
    check(
      'account-identity-read-error-unverified: throwing readCreds returns unverified with snapshot email instead of signed-out and is not cached',
      first?.state === 'unverified' && first.email === 'saved@example.com' && String(first.note ?? '').includes('keychain locked') && second?.state === 'signed-out',
      JSON.stringify(r),
    )
  }
} finally {
  rmSync(rootScratch, { recursive: true, force: true })
}

void runIsolated
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
