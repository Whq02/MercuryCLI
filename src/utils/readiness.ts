// ============================================================================
// readiness — the per-capability readiness truth center.
//
//  One SYNC collector computing typed readiness records from what the RUNNING
//  process can prove. Consumers: the capability center
//  (components/mercury-ui/parity/CapabilityManagerView — calls
//  collectReadiness() inside a useState initializer, so the collector MUST
//  stay synchronous) and the health JSON seam (cli/healthJson —
//  collectReadiness({ includeEnv: false })).
//
//  Laws:
//  · HONESTY — configuration alone never presents as live. An MCP server with
//    config but no in-process connection reads `configured`; a resolvable
//    binary that has never run reads `configured`; only a live in-process
//    fact reads `ready`. A failed live attempt reads `failed` and carries the
//    source's own error text (bounded).
//  · FAILURE ISOLATION — every section builder runs inside a guard; a throw
//    degrades to ONE unavailable record for that source, never a lost report.
//  · RENDER SAFETY — sync reads and cheap probes only (the owners' own
//    bounded, cached probes — the same probes boot/doctor run, so this table
//    and boot cannot disagree). No network, no server connects, no spawns
//    beyond the owners' cached probe paths.
//
//  Every input is a surviving owner; this module owns NO capability state of
//  its own — it projects the owners' truth into one record vocabulary.
// ============================================================================

import { FLAG_REGISTRY, flagEnabled, flagEnv, type FlagSpec } from '../substrate/flagRegistry.js'
import { bootEnvAppliedKeys } from '../substrate/startupMenu.js'
import { driverNodeGate, resolveBrowser } from '../services/browser/browserResolver.js'
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
import { extensionReadinessRows } from '../extensions/boot.js'
import { searchToolsAvailability } from './ripgrep.js'
import { mcpGauge } from './cockpit/mcpGauge.js'
import { whichSync } from './which.js'

//
// Vocabulary (export spellings pinned by the capability-center view and the
// doctor JSON consumer; the record fields by the view's property accesses).
//

/** The eight-state readiness vocabulary — a strict subset of SnapshotState so
 *  records feed StateBadge directly. */
export type ReadinessState =
  | 'ready' // callable RIGHT NOW in this process (probed, not assumed)
  | 'starting' // launch/connect in flight
  | 'configured' // config exists, no successful current-process connection
  | 'degraded' // callable but impaired
  | 'unavailable' // needed binary/source missing
  | 'disabled' // deliberately off
  | 'failed' // a live attempt failed
  | 'stale' // evidence predates what it certifies

export type ReadinessKind = 'tool' | 'mcp' | 'lane' | 'engine' | 'extension' | 'skill' | 'env'

export interface ReadinessRecord {
  /** Stable, kind-prefixed (`tool:search`, `mcp:<name>`, `env:MERCURY_*`…). */
  id: string
  kind: ReadinessKind
  label: string
  state: ReadinessState
  /** One honest reason line — single line; consumers truncate/wrap it. */
  detail: string
  /** The exact fix — present ONLY when actionable. */
  remedy?: string
  /** Provenance of the truth (which owner/probe produced this record). */
  source: string
  lastCheckedAt: number
  /** Probe wall time, when this collection actually paid a probe. */
  latencyMs?: number
  /** A change to this row's input takes effect only on relaunch. */
  restartRequired?: boolean
}

export interface ReadinessReport {
  records: ReadinessRecord[]
  collectedAt: number
}

//
// Helpers
//

/** Detail/error text is bounded — a stack trace must never shear the list. */
function bounded(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

/**
 * Failure isolation: one throwing source degrades to ONE
 * unavailable record and never breaks the rest of the report.
 */
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

//
// Tools — the search-binary probe and the capability kill-switch registry
//

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

//
// MCP — config snapshot merged with THIS process's connection store
//

function injectionNote(connection: MCPServerConnection): string {
  const type = connection.config?.type
  if (type === 'sdk') return ' (runtime-injected: SDK client)'
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
    // Configured, never touched by this process — the honesty law's core case.
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
  // The ONE MCP owner: configured rows joined with this process's live
  // connections (an empty runtime half reads `configured`, never `ready`).
  const gauge = mcpGauge()

  // OAuth-currency tail — enrichment only; its failure never breaks rows.
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

  // Config rows first, then the runtime-only clients (SDK-injected, the
  // editor bridge) that have no config row — the gauge's own order.
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

//
// Lanes — LSP · Python · C/C++ · DAP · binary adapters · browser
//

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

  // Per-server rows: three-state honesty — only a genuinely running server
  // reads ready; registered-but-idle is configured; a crashed one is failed.
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
      // 'stopped' | 'stopping' — registered, not live.
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
  // EVERY absent lane half contributes its remedy — a detail that says
  // "ruff ABSENT" while the remedy names only pyright leaves the operator
  // hunting for the install line (the remedy-completeness law).
  const remedies: string[] = []
  if (pythonLspOn && pyright !== null && !pyright.available && pyright.reason !== undefined) {
    remedies.push(pyright.reason)
  }
  if (pythonLspOn && ruff !== null && !ruff.available && ruff.reason !== undefined) {
    remedies.push(ruff.reason)
  }
  // Interpreter probed live (the owner ran it) — ready is honest; a missing
  // semantic server while the lane is armed is an impairment, not a fault.
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
    // ready-with-an-absent-companion still names the install line.
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
  // Binary present, never spawned by this row's probe — configured, per the
  // honesty law; a RUNNING mercury-clangd surfaces as its lane:lsp:* row.
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
  // The resolver's provenance IS the truth — the exact probe the launch path
  // runs, so `ready` here is honest (the adapter answered the probe).
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

  // The dedicated python-adapter row — the per-adapter truth the capability
  // view and the ide provers key on, with the provenance-bearing detail.
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

  // Binary-resolved adapters: resolved ⇒ configured, absent ⇒ unavailable
  // with the install hint. A found binary has NOT run — configured, never
  // ready. lldb rides the SAME resolver as the launch path (PATH, then
  // darwin's `xcrun -f lldb-dap` — CommandLineTools/Xcode ship it off PATH),
  // so this row and a real launch cannot disagree.
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
  // The remaining builtin lanes — js/go/dotnet/ruby — get the SAME
  // configured/unavailable treatment (the absent-adapter visibility
  // asymmetry: lldb/gdb had rows, the rest had silence; a lane one install
  // away from working must appear with its arm line).
  // The PARTIAL honesty this row carried ("the child-session leg is not
  // implemented, a launch is accepted but the debuggee does not run")
  // retired WITH its reason: dapClient answers startDebugging and walks the
  // child sessions now, so the js loop closes end to end — the row speaks
  // PROVENANCE instead (which ladder rung resolved the server).
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
          // The pin's OWN state first (FC-053): a set-but-missing
          // MERCURY_JS_DEBUG_DAP produced a row asserting the variable was
          // unset AND no vendored bundle existed — both false; the pin is
          // exclusive, so the other rungs are deliberately not consulted.
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
  // The unity attach row — OPT-IN: absent entirely while MERCURY_UNITY is
  // off (the boot-menu off contract), honest configured/unavailable when
  // armed. Same resolver as the adapter table (evidence = the launch truth).
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
  // The owning catalog gate (BrowserTool.browserToolEnabled) is exactly this
  // registered-flag read; the registry is consulted directly so readiness
  // never drags the tool/UI graph into its import chain.
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
  // Resolution is a filesystem fact, not a running browser session.
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
  // the detect-only server catalogue rows pass through unchanged (the
  // surviving owner already emits readiness-shaped records with its own ids).
  records.push(...serverCatalogueRecords())
  // Opt-in engine lanes: EMPTY while disarmed (the off contract — no row,
  // not even a disabled one; the surface is born only when armed).
  records.push(...unityLaneReadinessRecords())
  records.push(...unityBridgeReadinessRecords())
  records.push(...blenderLaneReadinessRecords())
  records.push(...blenderBridgeReadinessRecords())
  records.push(browserLaneRecord())
  return records
}

//
// Engines — the IDE plane, workflows, and the primary-backend receipts
//

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
  // Evidence-first summary; each read is enrichment-guarded so a corrupt
  // store can never take the row down with it.
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

/** One route-representative id per provider family the routing law
 *  declares (the same table callModelRouter dispatches on) — every landed
 *  family projects a row here, never a hand-kept subset. The home family
 *  probes by its own declared mark (claude-) like every other family — the
 *  remainder-era spelling here was `undefined` (absence ⇒ home), retired
 *  with the remainder by the phase-2 neutrality ruling. */
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
    // The probe list is declared exemplars, one per family — a null (no
    // family claims the id) cannot occur here; guarded for totality.
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
      // A settled native turn this session (or the main loop itself) — the
      // owner's receipt is the only path to `ready` here.
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

//
// Extensions and skills
//

/** The one health owner's readout, projected onto readiness rows. */
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

//
// Environment — one record per flag-registry row
//

/**
 * One readiness record for one registry row. The EFFECTIVE value comes from
 * the registry's own reader, so this table can never contradict the gates.
 * `bootKeys` = the spellings the boot-menu env file applied this process
 * (source attribution).
 */
export function flagReadinessRecord(spec: FlagSpec, bootKeys: ReadonlySet<string>): ReadinessRecord {
  const effective = flagEnv(spec.env)
  const source = bootKeys.has(spec.env)
    ? 'boot-env.json (boot menu)'
    : process.env[spec.env] !== undefined
      ? 'environment'
      : 'default (unset)'

  let state: ReadinessState
  let detail: string
  if (spec.kind === 'default-on' || spec.kind === 'opt-in') {
    // The registry's own gate answers — never a re-derived truthiness.
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

/** Every registry row as a readiness record — explicitly-set rows first,
 *  then by canonical name. */
export function envReadinessProjection(): ReadinessRecord[] {
  const bootKeys = bootEnvAppliedKeys()
  const rows = FLAG_REGISTRY.map(spec => ({
    record: flagReadinessRecord(spec, bootKeys),
    explicit: flagEnv(spec.env) !== undefined,
    name: spec.env,
  }))
  rows.sort((a, b) => {
    if (a.explicit !== b.explicit) return a.explicit ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return rows.map(row => row.record)
}

//
// The collector
//

/**
 * Build the full readiness report. Synchronous by contract (the capability
 * center calls it inside a state initializer). `includeEnv: false` drops the
 * env section (the doctor JSON seam passes it — the flag registry module
 * is the env catalog there).
 */
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
