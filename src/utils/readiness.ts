
import { FLAG_REGISTRY, flagEnabled, flagEnv, type FlagSpec } from '../substrate/flagRegistry.js'
import { realEnvPin } from '../substrate/startupMenu.js'
import { driverNodeGate, resolveBrowser } from '../services/browser/browserResolver.js'
import { lastDesktopPermissions, resolveDesktopDriver } from '../services/desktop/resolveDriver.js'
import { computerAccessWords } from '../services/desktop/computerAccess.js'
import { desktopGrantWords } from '../services/desktop/nativeDriver.js'
import { desktopClaimFileSnapshot } from '../services/desktop/desktopClaim.js'
import { desktopSnapshot } from '../services/desktop/desktopSession.js'
import {
  mercuryDapEnabled,
  probeGdbDap,
  jsDebugSourceLabel,
  resolveJsDebugServer,
  resolveLldbDap,
} from '../services/dap/dapClient.js'
import { latestTransaction, listTransactions, ideLoopEnabled, type TxRecord } from '../services/ide/ideTransaction.js'
import { projectPythonDebugAdapter, selectPythonInterpreter } from '../services/ide/pythonProject.js'
import { latestRun } from '../services/ide/pythonTests.js'
import { compileDbRemedy, mercuryLspCppEnabled, probeBuiltinClangd, probeCompileDb } from '../services/lsp/clangdLane.js'
import type { LSPServerInstance } from '../services/lsp/LSPServerInstance.js'
import { getInitializationStatus, getLspServerManager } from '../services/lsp/manager.js'
import { mercuryLspEnabled } from '../services/lsp/mercuryLsp.js'
import { mercuryLspPythonEnabled, probeBuiltinPyright } from '../services/lsp/pyrightLane.js'
import { probeRuff } from '../services/lsp/ruffLane.js'
import { serverCatalogueRecords } from '../services/lsp/serverCatalogue.js'
import { unityLaneReadinessRecords } from '../services/lsp/unityLane.js'
import { unityBridgeReadinessRecords } from '../services/ide/unityBridgeSession.js'
import { blenderBridgeReadinessRecords } from '../services/ide/blenderBridgeSession.js'
import { blenderLaneReadinessRecords } from '../services/ide/blenderProject.js'
import { mercuryUnityEnabled } from '../services/ide/unityProject.js'
import {
  resolveUnityDebugAdapter,
  UNITY_ADAPTER_ARM_HINT,
} from '../services/dap/unityAdapter.js'
import { summarizeMcpAuthCurrency } from '../services/mcp/auth.js'
import { isMcpServerDisabled } from '../services/mcp/config.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { resolvePrimaryAgentBackend } from '../services/providers/primaryBackend.js'
import { getBundledSkills } from '../skills/bundledSkills.js'
import { dynamicWorkflowsEnabled, workflowsManagedDisabled } from '../tools/WorkflowTool/workflowEnablement.js'
import { logForDebugging } from './debug.js'
import { listCapabilityKills } from './permissions/capabilityGate.js'
import { describeWindowsShellRoad } from './shell/windowsShellRoad.js'
import { extensionReadinessRows } from '../extensions/boot.js'
import { searchToolsAvailability } from './ripgrep.js'
import { mcpGauge } from './cockpit/mcpGauge.js'
import { whichSync } from './which.js'


export type ReadinessState =
  | 'ready'
  | 'starting'
  | 'configured'
  | 'degraded'
  | 'unavailable'
  | 'disabled'
  | 'failed'
  | 'stale'

export type ReadinessKind = 'tool' | 'mcp' | 'lane' | 'engine' | 'extension' | 'skill' | 'env'

export interface ReadinessRecord {
  id: string
  kind: ReadinessKind
  label: string
  state: ReadinessState
  detail: string
  remedy?: string
  source: string
  lastCheckedAt: number
  latencyMs?: number
  restartRequired?: boolean
}

export interface ReadinessReport {
  records: ReadinessRecord[]
  collectedAt: number
}


function bounded(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

function guardedSection(
  sectionId: string,
  kind: ReadinessKind,
  label: string,
  build: () => ReadinessRecord[],
): ReadinessRecord[] {
  try {
    return build()
  } catch (e) {
    logForDebugging(`readiness: ${sectionId} section degraded: ${String(e)}`)
    return [
      {
        id: `${kind}:${sectionId}`,
        kind,
        label,
        state: 'unavailable',
        detail: `section failed: ${bounded(messageOf(e), 160)}`,
        source: 'readiness section guard',
        lastCheckedAt: Date.now(),
      },
    ]
  }
}


function toolRecords(): ReadinessRecord[] {
  const records: ReadinessRecord[] = []

  const t0 = Date.now()
  const search = searchToolsAvailability()
  records.push({
    id: 'tool:search',
    kind: 'tool',
    label: 'search tools (ripgrep)',
    state: search.available ? 'ready' : 'unavailable',
    detail: search.available
      ? `${search.mode} binary at ${search.path}`
      : 'search tools suppressed — Grep/Glob cannot run without the search binary',
    ...(search.remedy !== undefined ? { remedy: search.remedy } : {}),
    source: 'ripgrep availability probe',
    lastCheckedAt: Date.now(),
    latencyMs: Date.now() - t0,
  })

  const shell = describeWindowsShellRoad()
  records.push({
    id: 'tool:shell',
    kind: 'tool',
    label: 'Bash tool shell',
    state: shell.absent ? 'unavailable' : shell.road === 'system' ? 'configured' : 'ready',
    detail: shell.line,
    ...(shell.fix !== undefined ? { remedy: shell.fix } : {}),
    source: 'Windows shell road',
    lastCheckedAt: Date.now(),
  })

  records.push(computerToolRecord())

  const kills = listCapabilityKills()
  const pairs: string[] = []
  for (const [agentType, tools] of Object.entries(kills)) {
    for (const tool of tools) pairs.push(`${agentType}:${tool}`)
  }
  if (pairs.length === 0) {
    records.push({
      id: 'tool:kill-switch',
      kind: 'tool',
      label: 'capability kill-switches',
      state: 'ready',
      detail: 'no capability kill-switches active',
      source: 'capability kill-switch registry',
      lastCheckedAt: Date.now(),
    })
  } else {
    const sample = pairs.slice(0, 4).join(', ')
    records.push({
      id: 'tool:kill-switch',
      kind: 'tool',
      label: 'capability kill-switches',
      state: 'degraded',
      detail: `${pairs.length} kill(s) active: ${sample}${pairs.length > 4 ? ', …' : ''}`,
      remedy: 'restore the killed capability (kills clear on restart; MERCURY_KILL re-seeds them at boot)',
      source: 'capability kill-switch registry',
      lastCheckedAt: Date.now(),
    })
  }
  return records
}

function drivingAgeWords(startedAt: number | null): string {
  if (startedAt === null) return 'now'
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
}

function computerToolRecord(): ReadinessRecord {
  const base = {
    id: 'tool:computer',
    kind: 'tool' as const,
    label: 'Computer tool',
    source: 'desktop driver resolver',
    lastCheckedAt: Date.now(),
  }
  if (!flagEnabled('MERCURY_COMPUTER_USE')) {
    return { ...base, state: 'disabled', detail: 'MERCURY_COMPUTER_USE=0 — Computer tool absent from the catalog; no desktop driver is touched' }
  }
  const t0 = Date.now()
  const resolution = resolveDesktopDriver()
  if (resolution.state === 'unavailable') {
    return {
      ...base,
      state: 'unavailable',
      detail: `${bounded(resolution.note, 180)} — Computer tool absent from the catalog`,
      ...(resolution.remedy !== null ? { remedy: resolution.remedy } : {}),
      latencyMs: Date.now() - t0,
    }
  }
  const facts = resolution.driver.describe()
  const now = resolution.driver.permissionsNow?.()
  const permissions = now !== undefined && now.ok ? now.value : lastDesktopPermissions()
  const denied =
    permissions === null
      ? null
      : permissions.screenCapture === 'denied'
        ? 'screen capture'
        : permissions.input === 'denied'
          ? 'input control'
          : null
  if (denied !== null) {
    return {
      ...base,
      state: 'degraded',
      detail: `driver ${resolution.source} resolved — ${denied} denied${permissions?.reason ? `: ${bounded(permissions.reason, 140)}` : ''}`,
      remedy: desktopGrantWords(),
      latencyMs: Date.now() - t0,
    }
  }
  const own = desktopSnapshot()
  const driving = own.phase === 'driving' ? own : desktopClaimFileSnapshot()
  if (driving.phase === 'driving') {
    return {
      ...base,
      state: 'ready',
      detail: `driving ${driving.app ?? 'the desktop'} since ${drivingAgeWords(driving.startedAt)}`,
      latencyMs: Date.now() - t0,
    }
  }
  return {
    ...base,
    state: 'configured',
    detail: `driver ${resolution.source} resolved (${facts.kind}) — no session driving · ${computerAccessWords()}`,
    latencyMs: Date.now() - t0,
  }
}


function injectionNote(connection: MCPServerConnection): string {
  const type = connection.config?.type
  if (type === 'host') return ' (host-served)'
  if (type === 'ws-ide' || type === 'sse-ide') return ' (runtime-injected: editor bridge)'
  return ' (runtime-injected)'
}

function mcpRow(
  name: string,
  connection: MCPServerConnection | undefined,
  runtimeInjected: boolean,
  oauthTail: string,
): ReadinessRecord {
  const id = `mcp:${name}`
  const source = runtimeInjected
    ? 'this process connection store (no config row)'
    : 'config.mcpServers + this process connection store'
  const base = { id, kind: 'mcp' as const, label: name, source, lastCheckedAt: Date.now() }
  const injected = connection !== undefined && runtimeInjected ? injectionNote(connection) : ''

  if (connection === undefined) {
    if (isMcpServerDisabled(name)) {
      return {
        ...base,
        state: 'disabled',
        detail: `disabled in config${oauthTail}`,
        remedy: 'enable it via /mcp',
      }
    }
    return {
      ...base,
      state: 'configured',
      detail: `configured — no connection in this process (connects at session start or on demand)${oauthTail}`,
    }
  }

  switch (connection.type) {
    case 'connected':
      return { ...base, state: 'ready', detail: `connected in this process${injected}${oauthTail}` }
    case 'pending': {
      const attempt =
        connection.reconnectAttempt !== undefined
          ? ` (attempt ${connection.reconnectAttempt}${connection.maxReconnectAttempts !== undefined ? `/${connection.maxReconnectAttempts}` : ''})`
          : ''
      return { ...base, state: 'starting', detail: `connect in flight${attempt}${injected}${oauthTail}` }
    }
    case 'needs-auth':
      return {
        ...base,
        state: 'degraded',
        detail: `server requires authentication${injected}${oauthTail}`,
        remedy: 'authenticate via /mcp, then reconnect',
      }
    case 'failed':
      return {
        ...base,
        state: 'failed',
        detail: `connection failed${connection.error ? `: ${bounded(connection.error, 140)}` : ''}${injected}${oauthTail}`,
        remedy: 'check the server command/url and its logs; reconnect via /mcp',
      }
    case 'disabled':
      return {
        ...base,
        state: 'disabled',
        detail: `disabled in config${injected}${oauthTail}`,
        remedy: 'enable it via /mcp',
      }
  }
}

function mcpRecords(): ReadinessRecord[] {
  const records: ReadinessRecord[] = []
  const gauge = mcpGauge()

  let oauthTail = ''
  try {
    const currency = summarizeMcpAuthCurrency()
    if (currency !== null && currency.expired > 0) {
      oauthTail = ` · OAuth: ${currency.expired} stored token(s) expired`
    } else if (currency !== null && currency.expiringSoon > 0) {
      oauthTail = ` · OAuth: ${currency.expiringSoon} stored token(s) expiring soon`
    }
  } catch {
    oauthTail = ''
  }

  if (gauge.state === 'unavailable') {
    records.push({
      id: 'mcp:config',
      kind: 'mcp',
      label: 'MCP configuration',
      state: 'unavailable',
      detail: gauge.reason ?? 'mcp config unreadable',
      source: 'config.mcpServers',
      lastCheckedAt: Date.now(),
    })
  }

  for (const row of gauge.data.servers) {
    records.push(mcpRow(row.name, row.connection, row.source === 'runtime', oauthTail))
  }

  if (gauge.state === 'off') {
    records.push({
      id: 'mcp:none',
      kind: 'mcp',
      label: 'MCP servers',
      state: 'disabled',
      detail: 'no MCP servers configured',
      remedy: 'add one: `mercury mcp add <name> …` (or /mcp in a session)',
      source: 'config.mcpServers',
      lastCheckedAt: Date.now(),
    })
  }
  return records
}


function lspLaneRecords(): ReadinessRecord[] {
  const records: ReadinessRecord[] = []
  if (!mercuryLspEnabled()) {
    records.push({
      id: 'lane:lsp',
      kind: 'lane',
      label: 'LSP bridge',
      state: 'disabled',
      detail: 'MERCURY_LSP=0 — the IDE-hands bridge is off',
      remedy: 'unset MERCURY_LSP (default-on) and relaunch',
      source: 'LSP manager',
      lastCheckedAt: Date.now(),
      restartRequired: true,
    })
    return records
  }

  const status = getInitializationStatus()
  if (status.status === 'failed') {
    records.push({
      id: 'lane:lsp',
      kind: 'lane',
      label: 'LSP bridge',
      state: 'failed',
      detail: `manager initialization failed: ${bounded(messageOf(status.error), 160)}`,
      remedy: 'reload extensions (re-initializes the manager) or relaunch',
      source: 'LSP manager',
      lastCheckedAt: Date.now(),
    })
    return records
  }
  if (status.status === 'pending') {
    records.push({
      id: 'lane:lsp',
      kind: 'lane',
      label: 'LSP bridge',
      state: 'starting',
      detail: 'manager initialization in flight',
      source: 'LSP manager',
      lastCheckedAt: Date.now(),
    })
    return records
  }
  if (status.status === 'not-started') {
    records.push({
      id: 'lane:lsp',
      kind: 'lane',
      label: 'LSP bridge',
      state: 'configured',
      detail: 'manager never initialized in this process (bare/headless run)',
      source: 'LSP manager',
      lastCheckedAt: Date.now(),
    })
    return records
  }

  const servers = getLspServerManager()?.getAllServers() ?? new Map<string, LSPServerInstance>()
  if (servers.size === 0) {
    records.push({
      id: 'lane:lsp',
      kind: 'lane',
      label: 'LSP bridge',
      state: 'configured',
      detail: 'initialized — zero language servers matched this workspace',
      source: 'LSP manager',
      lastCheckedAt: Date.now(),
    })
    return records
  }

  let running = 0
  for (const server of servers.values()) {
    if (server.state === 'running') running++
  }
  records.push({
    id: 'lane:lsp',
    kind: 'lane',
    label: 'LSP bridge',
    state: 'ready',
    detail: `initialized — ${running}/${servers.size} server(s) running in this process`,
    source: 'LSP manager',
    lastCheckedAt: Date.now(),
  })

  for (const server of servers.values()) {
    const base = {
      id: `lane:lsp:${server.name}`,
      kind: 'lane' as const,
      label: server.name,
      source: 'LSP manager (per-server state)',
      lastCheckedAt: Date.now(),
    }
    if (server.state === 'running') {
      records.push({ ...base, state: 'ready', detail: 'running in this process' })
    } else if (server.state === 'starting') {
      records.push({ ...base, state: 'starting', detail: 'server launch in flight' })
    } else if (server.state === 'error') {
      records.push({
        ...base,
        state: 'failed',
        detail: `server errored${server.lastError ? `: ${bounded(messageOf(server.lastError), 120)}` : ''} (${server.restartCount} restart(s))`,
        remedy: 'reload extensions to re-initialize, or fix the server binary/config it names',
      })
    } else {
      records.push({ ...base, state: 'configured', detail: 'registered — not running (lazy start on the first matching file)' })
    }
  }
  return records
}

function pythonLaneRecord(): ReadinessRecord {
  const t0 = Date.now()
  const py = selectPythonInterpreter()
  const pythonLspOn = mercuryLspPythonEnabled()
  const pyright = pythonLspOn ? probeBuiltinPyright() : null
  const ruff = pythonLspOn ? probeRuff() : null
  const latencyMs = Date.now() - t0
  const base = {
    id: 'lane:python',
    kind: 'lane' as const,
    label: 'Python lane',
    source: 'pythonProject selection + pyright/ruff lane probes (the boot probes)',
    lastCheckedAt: Date.now(),
    latencyMs,
  }
  if (py.state !== 'ok') {
    return {
      ...base,
      state: 'unavailable',
      detail: `python unavailable: ${bounded(py.detail, 140)}`,
      remedy: py.remedy,
    }
  }
  const parts = [`${py.command} ${py.version} (${py.envKind}, ${py.source})`]
  if (pythonLspOn) {
    parts.push(
      pyright?.available
        ? `pyright ${pyright.source ?? ''}${pyright.version ? ` ${pyright.version}` : ''}`.trim()
        : 'pyright ABSENT',
    )
    parts.push(ruff?.available ? `ruff ${ruff.version ?? 'ok'}` : 'ruff ABSENT')
  } else {
    parts.push('python LSP lanes off (MERCURY_LSP_PYTHON=0)')
  }
  const remedies: string[] = []
  if (pythonLspOn && pyright !== null && !pyright.available && pyright.reason !== undefined) {
    remedies.push(pyright.reason)
  }
  if (pythonLspOn && ruff !== null && !ruff.available && ruff.reason !== undefined) {
    remedies.push(ruff.reason)
  }
  if (pythonLspOn && pyright !== null && !pyright.available) {
    return {
      ...base,
      state: 'degraded',
      detail: parts.join(' · '),
      ...(remedies.length > 0 ? { remedy: remedies.join(' — and: ') } : {}),
    }
  }
  return {
    ...base,
    state: 'ready',
    detail: parts.join(' · '),
    ...(remedies.length > 0 ? { remedy: remedies.join(' — and: ') } : {}),
  }
}

function cppLaneRecord(): ReadinessRecord {
  const base = {
    id: 'lane:cpp',
    kind: 'lane' as const,
    label: 'C/C++ lane',
    source: 'clangd PATH probe + compile-DB walk',
    lastCheckedAt: Date.now(),
  }
  if (!mercuryLspCppEnabled()) {
    return {
      ...base,
      state: 'disabled',
      detail: mercuryLspEnabled() ? 'MERCURY_LSP_CPP=0 — clangd lane off' : 'MERCURY_LSP=0 — the IDE-hands bridge is off',
    }
  }
  const t0 = Date.now()
  const clangd = probeBuiltinClangd()
  if (!clangd.available) {
    return {
      ...base,
      state: 'unavailable',
      detail: 'no clangd binary found',
      ...(clangd.reason !== undefined ? { remedy: clangd.reason } : {}),
      latencyMs: Date.now() - t0,
    }
  }
  const db = probeCompileDb()
  return {
    ...base,
    state: 'configured',
    detail: `clangd at ${clangd.clangdPath} — engages on the first C/C++ file · compile DB ${db.compileDb ?? 'ABSENT'}`,
    ...(db.compileDb === undefined ? { remedy: compileDbRemedy(db) } : {}),
    latencyMs: Date.now() - t0,
  }
}

function dapLaneRecords(): ReadinessRecord[] {
  const records: ReadinessRecord[] = []
  if (!mercuryDapEnabled()) {
    records.push({
      id: 'lane:dap',
      kind: 'lane',
      label: 'DAP debug lane',
      state: 'disabled',
      detail: 'MERCURY_DAP=0 — Debug tool absent from the catalog',
      source: 'debugpy resolver',
      lastCheckedAt: Date.now(),
    })
    return records
  }

  const t0 = Date.now()
  const python = projectPythonDebugAdapter()
  if (python.state === 'ok') {
    const prov = python.provenance
    records.push({
      id: 'lane:dap',
      kind: 'lane',
      label: 'DAP debug lane',
      state: 'ready',
      detail: `python adapter: ${prov.adapterSource}${prov.debugpyVersion ? ` debugpy ${prov.debugpyVersion}` : ''}${prov.interpreter ? ` via ${prov.interpreter}` : ''}`,
      source: 'debugpy resolver (the launch path probe)',
      lastCheckedAt: Date.now(),
      latencyMs: Date.now() - t0,
    })
  } else {
    records.push({
      id: 'lane:dap',
      kind: 'lane',
      label: 'DAP debug lane',
      state: 'unavailable',
      detail: `python adapter unavailable: ${bounded(python.reason, 140)}`,
      remedy: python.remedy,
      source: 'debugpy resolver (the launch path probe)',
      lastCheckedAt: Date.now(),
      latencyMs: Date.now() - t0,
    })
  }

  if (python.state === 'ok') {
    const prov = python.provenance
    records.push({
      id: 'lane:dap:python',
      kind: 'lane',
      label: 'DAP · python',
      state: 'ready',
      detail:
        `debugpy ${prov.debugpyVersion ?? '?'} (${prov.adapterSource === 'bundled' ? 'BUNDLED pinned wheel' : 'installed module'}) · ` +
        `${prov.interpreter ?? '?'}${prov.interpreterVersion ? ` ${prov.interpreterVersion}` : ''} · pydevd import chain probed`,
      source: 'debugpy resolver probe (pydevd import chain, the launch-path probe)',
      lastCheckedAt: Date.now(),
    })
  } else {
    records.push({
      id: 'lane:dap:python',
      kind: 'lane',
      label: 'DAP · python',
      state: 'unavailable',
      detail: `no viable Python debug adapter — ${bounded(python.reason, 140)}`,
      remedy:
        'bun run scripts/vendor/fetch-debugpy.ts && bun run build.ts (bundles the pinned adapter), or pip install debugpy',
      source: 'debugpy resolver probe (pydevd import chain, the launch-path probe)',
      lastCheckedAt: Date.now(),
    })
  }

  const lldb = resolveLldbDap()
  records.push(
    lldb !== null
      ? {
          id: 'lane:dap:lldb',
          kind: 'lane',
          label: 'lldb-dap adapter',
          state: 'configured',
          detail: `lldb-dap at ${lldb.path}${lldb.source === 'xcrun' ? ' (via the darwin toolchain — xcrun -f lldb-dap)' : ''} — launches on demand`,
          source: lldb.source === 'xcrun' ? 'shared lldb-dap resolver (xcrun)' : 'shared lldb-dap resolver (PATH)',
          lastCheckedAt: Date.now(),
        }
      : {
          id: 'lane:dap:lldb',
          kind: 'lane',
          label: 'lldb-dap adapter',
          state: 'unavailable',
          detail: 'no lldb-dap on PATH and the darwin toolchain resolver found none',
          remedy: 'install the Xcode CommandLineTools (xcode-select --install) — they ship lldb-dap; older toolchains name it lldb-vscode',
          source: 'shared lldb-dap resolver (PATH + xcrun)',
          lastCheckedAt: Date.now(),
        },
  )
  const gdb = probeGdbDap()
  records.push(
    gdb.viable
      ? {
          id: 'lane:dap:gdb',
          kind: 'lane',
          label: 'gdb adapter',
          state: 'configured',
          detail: `gdb${gdb.version ? ` ${gdb.version}` : ''} with the native DAP interpreter (-i=dap) — launches on demand`,
          source: 'gdb version probe',
          lastCheckedAt: Date.now(),
        }
      : {
          id: 'lane:dap:gdb',
          kind: 'lane',
          label: 'gdb adapter',
          state: 'unavailable',
          detail: gdb.reason ?? 'no gdb on PATH',
          remedy: 'install gdb 14+ (the first release with the native -i=dap interpreter)',
          source: 'gdb version probe',
          lastCheckedAt: Date.now(),
        },
  )
  const jsDebug = resolveJsDebugServer()
  records.push(
    jsDebug !== null
      ? {
          id: 'lane:dap:js',
          kind: 'lane',
          label: 'js-debug adapter (JS/TS)',
          state: 'configured',
          detail: `js-debug DAP server via ${jsDebugSourceLabel(jsDebug.source)}: ${jsDebug.path} — multi-session (resolution only; doctor --deep boots it)`,
          source: 'js-debug resolution (MERCURY_JS_DEBUG_DAP > vendored bundle > ~/.js-debug)',
          lastCheckedAt: Date.now(),
        }
      : (() => {
          const pinnedJsDebug = flagEnv('MERCURY_JS_DEBUG_DAP')
          return pinnedJsDebug && pinnedJsDebug.length > 0
            ? {
                id: 'lane:dap:js',
                kind: 'lane' as const,
                label: 'js-debug adapter (JS/TS)',
                state: 'unavailable' as const,
                detail: `MERCURY_JS_DEBUG_DAP is set but ${pinnedJsDebug} does not exist — the pin is exclusive, so the vendored/unpacked roads are deliberately not consulted`,
                remedy: 'fix MERCURY_JS_DEBUG_DAP to point at dapDebugServer.js, or unset it to fall back to the vendored bundle',
                source: 'js-debug resolution (MERCURY_JS_DEBUG_DAP > vendored bundle > ~/.js-debug)',
                lastCheckedAt: Date.now(),
              }
            : {
                id: 'lane:dap:js',
                kind: 'lane' as const,
                label: 'js-debug adapter (JS/TS)',
                state: 'unavailable' as const,
                detail: 'no vendored js-debug beside the artifact, no ~/.js-debug unpack, MERCURY_JS_DEBUG_DAP unset',
                remedy:
                  'rebuild with the vendored js-debug (bun run scripts/vendor/fetch-js-debug.ts && bun run build.ts), point MERCURY_JS_DEBUG_DAP at dapDebugServer.js, or unpack js-debug-dap to ~/.js-debug',
                source: 'js-debug resolution (MERCURY_JS_DEBUG_DAP > vendored bundle > ~/.js-debug)',
                lastCheckedAt: Date.now(),
              }
        })(),
  )
  const binaryLanes: Array<{ id: string; label: string; binary: string; remedy: string }> = [
    {
      id: 'lane:dap:go',
      label: 'dlv adapter (Go)',
      binary: 'dlv',
      remedy: 'go install github.com/go-delve/delve/cmd/dlv@latest',
    },
    {
      id: 'lane:dap:dotnet',
      label: 'netcoredbg adapter (.NET)',
      binary: 'netcoredbg',
      remedy: 'brew install netcoredbg (or the Samsung/netcoredbg releases)',
    },
    {
      id: 'lane:dap:ruby',
      label: 'rdbg adapter (Ruby)',
      binary: 'rdbg',
      remedy: 'gem install debug (provides rdbg)',
    },
  ]
  if (mercuryUnityEnabled()) {
    const unity = resolveUnityDebugAdapter()
    records.push(
      'reason' in unity
        ? {
            id: 'lane:dap:unity',
            kind: 'lane',
            label: 'unity adapter (attach-to-editor)',
            state: 'unavailable',
            detail: bounded(unity.reason, 200),
            remedy: UNITY_ADAPTER_ARM_HINT,
            source: 'unity adapter resolver (pin > vstuc extension > unpack)',
            lastCheckedAt: Date.now(),
          }
        : {
            id: 'lane:dap:unity',
            kind: 'lane',
            label: 'unity adapter (attach-to-editor)',
            state: 'configured',
            detail: `UnityDebugAdapter.dll (${unity.source}) at ${unity.dll} via ${unity.dotnet} — every gesture attaches to the RUNNING editor (port 56000 + editor pid % 1000, read from Library/EditorInstance.json)`,
            source: 'unity adapter resolver (pin > vstuc extension > unpack)',
            lastCheckedAt: Date.now(),
          },
    )
  }
  for (const lane of binaryLanes) {
    const found = whichSync(lane.binary)
    records.push(
      found !== null && found !== undefined
        ? {
            id: lane.id,
            kind: 'lane',
            label: lane.label,
            state: 'configured',
            detail: `${lane.binary} at ${found} — launches on demand`,
            source: 'PATH probe',
            lastCheckedAt: Date.now(),
          }
        : {
            id: lane.id,
            kind: 'lane',
            label: lane.label,
            state: 'unavailable',
            detail: `no ${lane.binary} on PATH`,
            remedy: lane.remedy,
            source: 'PATH probe',
            lastCheckedAt: Date.now(),
          },
    )
  }
  return records
}

function browserLaneRecord(): ReadinessRecord {
  const base = {
    id: 'lane:browser',
    kind: 'lane' as const,
    label: 'browser lane',
    source: 'browser resolver (pin > installed > managed cache)',
    lastCheckedAt: Date.now(),
  }
  if (!flagEnabled('MERCURY_BROWSER')) {
    return { ...base, state: 'disabled', detail: 'MERCURY_BROWSER=0 — Browser tool absent from the catalog' }
  }
  const t0 = Date.now()
  const resolution = resolveBrowser()
  if (resolution.state === 'unavailable') {
    return {
      ...base,
      state: 'unavailable',
      detail: bounded(resolution.note, 180),
      remedy: resolution.remedies.join(' · '),
      latencyMs: Date.now() - t0,
    }
  }
  const gate = driverNodeGate()
  if (!gate.ok) {
    return {
      ...base,
      state: 'degraded',
      detail: `${resolution.label} resolved (${resolution.source}) — drive ops refused: ${bounded(gate.note, 160)}`,
      latencyMs: Date.now() - t0,
    }
  }
  return {
    ...base,
    state: 'configured',
    detail: `${resolution.label} resolved (${resolution.source}) at ${resolution.executablePath} — no session running`,
    latencyMs: Date.now() - t0,
  }
}

function laneRecords(): ReadinessRecord[] {
  const records: ReadinessRecord[] = []
  records.push(...lspLaneRecords())
  records.push(pythonLaneRecord())
  records.push(cppLaneRecord())
  records.push(...dapLaneRecords())
  records.push(...serverCatalogueRecords())
  records.push(...unityLaneReadinessRecords())
  records.push(...unityBridgeReadinessRecords())
  records.push(...blenderLaneReadinessRecords())
  records.push(...blenderBridgeReadinessRecords())
  records.push(browserLaneRecord())
  return records
}


function idePlaneRecord(): ReadinessRecord {
  const base = {
    id: 'engine:ide-plane',
    kind: 'engine' as const,
    label: 'IDE transaction plane',
    source: 'transaction store + test-run store (durable records)',
    lastCheckedAt: Date.now(),
  }
  if (!ideLoopEnabled()) {
    return {
      ...base,
      state: 'disabled',
      detail: 'MERCURY_IDE_LOOP=0 — Transaction tool absent, no records written',
    }
  }
  const parts: string[] = ['closed-loop transaction plane armed']
  try {
    const record: TxRecord | null = latestTransaction()
    if (record !== null) {
      const unresolvedCount = Array.isArray(record.unresolved) ? record.unresolved.length : 0
      parts.push(`latest: ${record.id} [${record.verdict}] (${unresolvedCount} unresolved)`)
    } else {
      parts.push('no transactions recorded in this project')
    }
    const rows: readonly unknown[] = listTransactions()
    if (rows.length > 0) parts.push(`${rows.length} recorded`)
  } catch (e) {
    parts.push(`transaction store unreadable: ${bounded(messageOf(e), 80)}`)
  }
  try {
    const test = latestRun()
    parts.push(
      test !== null
        ? `latest test run: ${test.id} (${test.counts.failed === 0 ? 'green' : `${test.counts.failed} failing`})`
        : 'no test runs recorded',
    )
  } catch (e) {
    parts.push(`test-run store unreadable: ${bounded(messageOf(e), 80)}`)
  }
  return { ...base, state: 'ready', detail: parts.join(' · ') }
}

function workflowsRecord(): ReadinessRecord {
  const base = {
    id: 'engine:workflows',
    kind: 'engine' as const,
    label: 'workflow engine',
    source: 'workflow enablement gates',
    lastCheckedAt: Date.now(),
  }
  if (dynamicWorkflowsEnabled()) {
    return { ...base, state: 'ready', detail: 'dynamic workflows armed (default-on)' }
  }
  if (workflowsManagedDisabled()) {
    return {
      ...base,
      state: 'disabled',
      detail: 'disabled by policy (managed settings disableWorkflows)',
    }
  }
  return {
    ...base,
    state: 'disabled',
    detail: 'MERCURY_WORKFLOWS=0 — operator opt-out',
    remedy: 'unset MERCURY_WORKFLOWS (default-on)',
  }
}

function backendRemedy(backendId: string): string | undefined {
  if (backendId === 'openai-responses') return 'connect an OpenAI account or API key (/logins)'
  if (backendId === 'zai-glm') return 'add a Z.AI API key via /logins zai (or set ZAI_API_KEY)'
  if (backendId === 'moonshot-chat') return 'sign in with Kimi or add a Moonshot key via /logins moonshot (or set MOONSHOT_API_KEY)'
  if (backendId === 'deepseek-chat') return 'add a DeepSeek API key via /logins deepseek (or set DEEPSEEK_API_KEY)'
  if (backendId === 'openai-compat-chat') return 'set MERCURY_COMPAT_BASE_URL (key optional — /router key compat)'
  if (backendId === 'openrouter-chat') return 'connect OpenRouter via /logins (OAuth mints a key) or set OPENROUTER_API_KEY'
  if (backendId === 'gemini-generate') return 'connect Gemini via /logins (API key or Google OAuth) or set GOOGLE_API_KEY / GEMINI_API_KEY'
  if (backendId === 'huggingface-chat') return 'connect Hugging Face via /logins (device-code sign-in or a token) or set HF_TOKEN'
  if (backendId === 'local-chat') return 'start Ollama / LM Studio / vLLM / llama.cpp-server, or point MERCURY_LOCAL_BASE_URL at your server'
  return undefined
}

const BACKEND_ROUTE_PROBES: readonly string[] = [
  'claude-probe',
  'gpt',
  'glm',
  'kimi',
  'deepseek',
  'compat/probe',
  'openrouter/probe/probe',
  'gemini',
  'huggingface/probe/probe',
  'local/probe',
]

function backendRecords(): ReadinessRecord[] {
  const records: ReadinessRecord[] = []
  for (const routeModel of BACKEND_ROUTE_PROBES) {
    const backend = resolvePrimaryAgentBackend(routeModel)
    if (backend === null) continue
    const receipt = backend.readiness()
    const base = {
      id: `engine:backend:${backend.id}`,
      kind: 'engine' as const,
      label: backend.label,
      source: 'primary-backend readiness receipt',
      lastCheckedAt: Date.now(),
    }
    if (receipt.state === 'ready') {
      records.push({ ...base, state: 'ready', detail: bounded(receipt.detail, 200) })
    } else if (receipt.state === 'configured') {
      records.push({ ...base, state: 'configured', detail: bounded(receipt.detail, 200) })
    } else {
      const remedy = backendRemedy(backend.id)
      records.push({
        ...base,
        state: 'unavailable',
        detail: bounded(receipt.reason, 200),
        ...(remedy !== undefined ? { remedy } : {}),
      })
    }
  }
  return records
}

function engineRecords(): ReadinessRecord[] {
  return [idePlaneRecord(), workflowsRecord(), ...backendRecords()]
}


function extensionRecords(): ReadinessRecord[] {
  return extensionReadinessRows().map(row => ({ ...row, lastCheckedAt: Date.now() }))
}

function skillRecords(): ReadinessRecord[] {
  const bundled = getBundledSkills()
  return [
    {
      id: 'skill:registry',
      kind: 'skill',
      label: 'skills',
      state: bundled.length > 0 ? 'ready' : 'disabled',
      detail:
        bundled.length > 0
          ? `${bundled.length} bundled skill(s) registered in this process · user/project/extension skills load per session`
          : 'no bundled skills registered in this process',
      source: 'bundled skill registry (in-process)',
      lastCheckedAt: Date.now(),
    },
  ]
}


export function flagReadinessRecord(spec: FlagSpec): ReadinessRecord {
  const effective = flagEnv(spec.env)
  const source =
    effective === undefined
      ? 'default (unset)'
      : realEnvPin(spec.env) !== null
        ? 'environment'
        : 'boot-env.json (boot menu)'

  let state: ReadinessState
  let detail: string
  if (spec.kind === 'default-on' || spec.kind === 'opt-in') {
    const on = flagEnabled(spec.env)
    if (on) {
      state = 'ready'
      detail = `${spec.kind === 'default-on' ? (effective !== undefined ? `on (=${effective})` : 'on (default)') : `opted in (=${effective ?? '1'})`} — ${spec.summary}`
    } else {
      state = 'disabled'
      detail = `off — ${spec.off}`
    }
  } else if (effective !== undefined) {
    state = 'configured'
    detail = `= ${bounded(effective, 48)} — ${spec.summary}`
  } else {
    state = 'ready'
    detail = `unset — default: ${spec.off}`
  }

  return {
    id: `env:${spec.env}`,
    kind: 'env',
    label: spec.env,
    state,
    detail: bounded(detail, 300),
    source,
    lastCheckedAt: Date.now(),
  }
}

export function envReadinessProjection(): ReadinessRecord[] {
  const rows = FLAG_REGISTRY.map(spec => ({
    record: flagReadinessRecord(spec),
    explicit: flagEnv(spec.env) !== undefined,
    name: spec.env,
  }))
  rows.sort((a, b) => {
    if (a.explicit !== b.explicit) return a.explicit ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return rows.map(row => row.record)
}


export function collectReadiness(opts?: { includeEnv?: boolean }): ReadinessReport {
  const records: ReadinessRecord[] = [
    ...guardedSection('tools', 'tool', 'tools', toolRecords),
    ...guardedSection('servers', 'mcp', 'MCP servers', mcpRecords),
    ...guardedSection('lanes', 'lane', 'language & debug lanes', laneRecords),
    ...guardedSection('engines', 'engine', 'engines', engineRecords),
    ...guardedSection('health', 'extension', 'extensions', extensionRecords),
    ...guardedSection('registry', 'skill', 'skills', skillRecords),
  ]
  if (opts?.includeEnv !== false) {
    records.push(...guardedSection('flags', 'env', 'environment (flag registry)', envReadinessProjection))
  }
  return { records, collectedAt: Date.now() }
}
