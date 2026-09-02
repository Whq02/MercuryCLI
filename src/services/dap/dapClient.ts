// ============================================================================
//  DAP client — the Debug Adapter Protocol half of the IDE-hands bridge
//  (phase 2; phase 1 is the LSP bridge, services/lsp/*). Gives the agent a
//  REAL debugger instead of print-statement archaeology: breakpoints,
//  stepping, stacks, scopes, variables, evaluate — through any DAP adapter
//  that speaks stdio.
//
//  Design (deliberately v1-bounded, capability parity target is
//  the debugging LOOP, not any specific competitor's op count):
//   · stdio adapters only (debugpy, lldb-dap, custom via MERCURY_DAP_ADAPTERS).
//     Socket-listening adapters (dlv dap) are a documented non-goal for v1.
//   · one client, standard DAP dance: initialize → launch → 'initialized'
//     event → setBreakpoints → configurationDone → run. Stopped/terminated/
//     output events are collected; requests correlate on seq with timeouts.
//   · CHILD SESSIONS (the multi-session protocol shape — js-debug spawns a
//     session per target, debugpy per subprocess): the adapter's
//     startDebugging reverse request starts a child session on the same
//     adapter — tcp adapters re-dial the shared server (the js-debug
//     dapDebugServer contract: one connection per session, children keyed by
//     the configuration's __pendingTargetId), stdio adapters get a fresh
//     process of the same spec. The alias names the TREE: children live
//     inside their root session, share its output ring, re-apply its
//     requested breakpoints (the child is the verifier — a multi-session
//     parent binds nothing), and debuggee-facing ops route to the stopped
//     member (debugTarget — ambiguity answers typed, never a guess).
//   · named sessions (default 'main') in a module registry; disconnect kills
//     the child — no orphaned debuggees (the LSP zombie lessons applied
//     from birth).
//
//  Gate: MERCURY_DAP (registry 'default-on' — default-ON, `=0` removes
//  the Debug tool from the catalog entirely; bare-stamp builds never see it).
//  Proof: scripts/dap/prove-dap.ts (deterministic mock adapter).
// ============================================================================

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { debugpyVendorRoot, pythonSpawnEnv } from './debugpyResolver.js'
import * as path from 'node:path'
import type { OwnerKey } from '../run/ownerKey.js'
import {
  registerOwnerDisposer,
  unregisterOwnerDisposer,
} from '../run/ownerLifecycle.js'
import { registerExecutionDomain } from '../primitives/executionPlane.js'
import { projectExternalState } from '../primitives/externalProjection.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { endProcessTree, endProcessTreeSurvivors } from '../../utils/processGroup.js'
import {
  findGodotProjectRoot,
  godotBridgeCommand,
  godotDapPort,
  godotEditorHint,
  mercuryGodotEnabled,
  GODOT_DAP_ADAPTER_KEY,
} from '../lsp/godotLane.js'
import { projectPythonDebugAdapter } from '../ide/pythonProject.js'
import { mercuryUnityEnabled } from '../ide/unityProject.js'
import {
  buildUnityAttachArgs,
  resolveUnityDebugAdapter,
  unityEditorHint,
  UNITY_ADAPTER_ARM_HINT,
  UNITY_DAP_ADAPTER_KEY,
} from './unityAdapter.js'

/** The launch-request shaping input (what the Debug tool collected). */
export type DapLaunchOptions = {
  program: string
  args?: string[]
  cwd: string
  stopOnEntry?: boolean
}

/** One source breakpoint — plain line, or rich. Conditions /
 *  hit counts / logpoints are CALLER-gated on the adapter's capabilities. */
export type DapBreakpointSpec = {
  line: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

export type DapAdapterSpec = {
  command: string
  args: string[]
  /** Shown in errors when the adapter binary is missing. */
  installHint?: string
  /**
   * Adapter-specific launch-request arguments (builtin adapters only — the
   * MERCURY_DAP_ADAPTERS JSON table cannot carry functions). Omitted ⇒ the
   * standard {program, args, cwd, stopOnEntry} body every stdio debugger
   * understands. The godot adapter uses this to speak the editor's contract:
   * {project, scene, playArgs} (pinned from debug_adapter_parser.cpp).
   */
  buildLaunchArgs?: (options: DapLaunchOptions) => Record<string, unknown>
  /**
   * A resolver-established refusal: the adapter is KNOWN to
   * be unusable (no viable interpreter / no debugpy anywhere) and launching
   * would only produce a doomed child. createDapSession throws this message
   * (plus installHint) BEFORE spawning — an honest unavailable, not a hang.
   */
  preflightError?: string
  /**
   * Adapter-specific ATTACH-request arguments (builtin adapters only — the
   * buildLaunchArgs sibling; the builder owns the body whole, no
   * attachDefaults merge). The unity row uses this to speak the vstuc
   * contract: {type, endPoint, projectPath} with the endpoint derived from
   * an explicit port/pid or the project's Library/EditorInstance.json. A
   * throw here is the honest at-use refusal (teaching line), surfaced by
   * createDapSession with the install hint + output tail.
   */
  buildAttachArgs?: (options: {
    program: string
    cwd: string
    host?: string
    port?: number
    pid?: number
  }) => Record<string, unknown>
  /** Transport: 'stdio' (default) frames on the child's pipes; 'tcp' spawns
   *  the command (with `${port}` substituted by a free loopback port) and
   *  frames on a socket to 127.0.0.1:port — the dlv/js-debug server shape. */
  connect?: 'stdio' | 'tcp'
  /** Extensions this adapter credibly owns ('.go') — auto-pick metadata. */
  fileTypes?: string[]
  /** Workspace markers ('go.mod') — auto-pick metadata for directory programs. */
  rootMarkers?: string[]
  /** Extra fields merged into the launch request body (config-file rows). */
  launchDefaults?: Record<string, unknown>
  /** Extra fields merged into the attach request body (config-file rows). */
  attachDefaults?: Record<string, unknown>
  /** How an attach body spells its target: 'connect' nests {connect:{host,
   *  port}} (debugpy); 'flat' passes {host?, port?, pid?, program?}. */
  attachShape?: 'connect' | 'flat'
  /** Adapters (rdbg) that HOST the debuggee themselves: Mercury's launch op
   *  spawns them with `${program}` substituted and then sends THIS start
   *  request instead of 'launch'. */
  startRequest?: 'launch' | 'attach'
}

/** Godot launch mapping: program → project root; args[0] → scene; rest → playArgs. */
function godotLaunchArgs(options: DapLaunchOptions): Record<string, unknown> {
  const programDir = options.program.endsWith('project.godot')
    ? path.dirname(options.program)
    : options.program
  const project =
    findGodotProjectRoot(programDir) ?? findGodotProjectRoot(options.cwd) ?? programDir
  const scene = options.args?.[0] ?? 'main'
  const playArgs = options.args?.slice(1) ?? []
  return {
    project,
    scene,
    noDebug: false,
    ...(playArgs.length ? { playArgs } : {}),
  }
}

/**
 * Builtin stdio adapters (extend via MERCURY_DAP_ADAPTERS). A function, not a
 * constant: the `godot` row exists only while the Godot lane is armed
 * (MERCURY_GODOT=1), and its bridge target re-reads the port env live.
 */
/** The python spec, resolver-driven THROUGH the shared
 *  Python project owner (the same interpreter the Workshop and
 *  tests use leads the candidates; an explicit MERCURY_PYTHON pin is
 *  exclusive): health-checked interpreter + vendored-tree-first adapter
 *  source, honest preflight refusal when neither the bundled tree nor an
 *  installed debugpy is viable. LAZY — only resolveAdapter('python') pays
 *  the (30s-cached) interpreter probe; key listings never do. */
function pythonAdapterSpec(): DapAdapterSpec {
  const python = projectPythonDebugAdapter()
  return python.state === 'ok'
    ? {
        command: python.command,
        args: python.args,
        installHint:
          python.provenance.adapterSource === 'bundled'
            ? `bundled debugpy ${python.provenance.debugpyVersion ?? ''} via ${python.provenance.interpreter ?? 'python3'}`.trim()
            : 'pip install debugpy',
      }
    : {
        command: 'python3',
        args: ['-m', 'debugpy.adapter'],
        installHint: python.remedy,
        preflightError: python.reason,
      }
}

// ── the GDB fallback adapter ─────────────────────────────────
// GDB grew a native DAP interpreter (`gdb -i=dap`) in GDB 14 — the common
// native lane on Linux boxes that carry gdb but no lldb-dap. The row is
// PROBED, never assumed (mirrors the godot conditional row): binary on PATH
// AND `gdb --version` major ≥ 14, else the row is absent and the reason is
// loggable. 30s env-keyed cache; _resetGdbProbeForTesting for the proofs.

const GDB_DAP_MIN_MAJOR = 14

export interface GdbProbe {
  viable: boolean
  version?: string
  reason?: string
}

let gdbProbeCache: { at: number; key: string; result: GdbProbe } | null = null
const GDB_PROBE_TTL_MS = 30_000

function findOnPathLocal(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix)
      try {
        if (process.platform === 'win32') {
          if (existsSync(candidate)) return candidate
        } else {
          accessSync(candidate, constants.X_OK)
          return candidate
        }
      } catch {
        /* next candidate */
      }
    }
  }
  return undefined
}

/** TEST-ONLY: drop the gdb probe cache (PATH-shim proofs). */
export function _resetGdbProbeForTesting(): void {
  gdbProbeCache = null
}

// ── lldb-dap resolution ──────────────────────────────────────────────────────
// PATH first; on darwin the toolchain's own resolver second: Xcode AND the
// CommandLineTools ship lldb-dap OFF PATH (/Library/Developer/
// CommandLineTools/usr/bin/lldb-dap), where `xcrun -f lldb-dap` names it —
// a Mac with a working C toolchain HAS a native debug adapter, and a
// PATH-only probe reporting "unavailable — run xcrun -f lldb-dap" told the
// operator to run the resolver the product can run itself (the live smoke,
// scripts/dap/live-dap-smoke.sh, always resolved via xcrun; the product row
// now matches it). Memoized per process: a toolchain path does not move
// mid-session, and every status surface re-reads this one owner.

// ── macOS debugger authorisation ────────────────────────────────────────────
// A native adapter (lldb-dap · gdb) that starts and then never answers is,
// on macOS, usually the operating system: without Developer Mode,
// task_for_pid waits for an interactive authorisation a debug adapter
// cannot give, and the grant lasts one boot — so the first native launch
// after a restart blocks silently and the initialized deadline fires
// honestly. The setting is read LIVE (`DevToolsSecurity -status`) and the
// silence message names it with the one durable fix. Memoised per process.

const NATIVE_ADAPTER_KEYS = new Set(['lldb', 'gdb'])
let darwinDebuggerAuthMemo: string | null | undefined

/** TEST-ONLY: drop the authorisation memo. */
export function _resetDarwinDebuggerAuthForTesting(): void {
  darwinDebuggerAuthMemo = undefined
}

/** The macOS debugger-authorisation hint when the OS setting is off; null
 *  elsewhere, when it is on, or when the setting cannot be read. */
export function darwinDebuggerAuthorisationHint(): string | null {
  if (process.platform !== 'darwin') return null
  if (darwinDebuggerAuthMemo !== undefined) return darwinDebuggerAuthMemo
  try {
    const status = spawnSync('DevToolsSecurity', ['-status'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 3_000,
      windowsHide: true,
      env: subprocessEnv(),
    })
    const text = `${status.stdout ?? ''}${status.stderr ?? ''}`
    darwinDebuggerAuthMemo = /disabled/i.test(text)
      ? 'macOS debugger authorisation is off (DevToolsSecurity -status: disabled) — a native debugger blocks in task_for_pid until it is granted, and the grant lasts one boot; enable it durably with: sudo DevToolsSecurity -enable'
      : null
  } catch {
    darwinDebuggerAuthMemo = null
  }
  return darwinDebuggerAuthMemo
}

/** The message for an adapter that never answered: for a native adapter on
 *  macOS the authorisation state is read live and named beside the deadline;
 *  every other adapter keeps the bare deadline. */
export function adapterSilenceMessage(base: string, adapterKey: string): string {
  if (!NATIVE_ADAPTER_KEYS.has(adapterKey)) return base
  const hint = darwinDebuggerAuthorisationHint()
  return hint === null ? base : `${base} — ${hint}`
}

export interface LldbDapResolution {
  path: string
  source: 'path' | 'xcrun'
}

let lldbDapMemo: LldbDapResolution | null | undefined

/** TEST-ONLY: drop the lldb-dap memo (PATH/xcrun-shim proofs). */
export function _resetLldbDapForTesting(): void {
  lldbDapMemo = undefined
}

/** The ONE lldb-dap resolver — shared by the builtin adapter row and
 *  /health's lane:dap:lldb, so evidence and launch behavior agree. */
export function resolveLldbDap(): LldbDapResolution | null {
  if (lldbDapMemo !== undefined) return lldbDapMemo
  const onPath = findOnPathLocal('lldb-dap')
  if (onPath) {
    lldbDapMemo = { path: onPath, source: 'path' }
    return lldbDapMemo
  }
  if (process.platform === 'darwin') {
    try {
      // env spread is load-bearing under Bun (the recorded house lesson).
      const r = spawnSync('xcrun', ['-f', 'lldb-dap'], {
        windowsHide: true,
        timeout: 5_000,
        encoding: 'utf8',
        env: { ...subprocessEnv() },
      })
      const found = (r.stdout ?? '').trim()
      if (r.status === 0 && found && existsSync(found)) {
        lldbDapMemo = { path: found, source: 'xcrun' }
        return lldbDapMemo
      }
    } catch {
      /* no xcrun (non-Xcode box) — the row stays honest-unavailable */
    }
  }
  lldbDapMemo = null
  return lldbDapMemo
}

export function probeGdbDap(): GdbProbe {
  const key = process.env.PATH ?? ''
  if (gdbProbeCache && gdbProbeCache.key === key && Date.now() - gdbProbeCache.at < GDB_PROBE_TTL_MS) {
    return gdbProbeCache.result
  }
  let result: GdbProbe
  const bin = findOnPathLocal('gdb')
  if (!bin) {
    result = { viable: false, reason: 'no gdb on PATH' }
  } else {
    try {
      // env spread is load-bearing under Bun (the recorded house lesson).
      const r = spawnSync(bin, ['--version'], { windowsHide: true, timeout: 5_000, encoding: 'utf8', env: { ...subprocessEnv() } })
      const firstLine = (r.stdout ?? '').split('\n')[0] ?? ''
      const m = firstLine.match(/(\d+)\.(\d+)/)
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
        // A hung gdb is not "unparseable output" — name the timeout (the
        // spawnSync ETIMEDOUT diagnostics class).
        result = { viable: false, reason: 'gdb --version timed out after 5s — the binary hangs; check the install' }
      } else if (r.status !== 0 || !m || m[1] === undefined) {
        result = { viable: false, reason: `gdb --version unparseable: ${firstLine.slice(0, 80) || `exit ${r.status ?? 'null'}`}` }
      } else if (Number(m[1]) < GDB_DAP_MIN_MAJOR) {
        result = {
          viable: false,
          version: m[0],
          reason: `gdb ${m[0]} predates the DAP interpreter — gdb ${GDB_DAP_MIN_MAJOR}+ provides -i=dap`,
        }
      } else {
        result = { viable: true, version: m[0] }
      }
    } catch (e) {
      result = { viable: false, reason: `gdb probe failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  gdbProbeCache = { at: Date.now(), key, result }
  return result
}

// ── install remedies, per host ──────────────────────────────────────────────
// A failed native launch on Windows named xcode-select --install, and the
// dormant-lane list beside it named brew install netcoredbg — neither exists
// there, and nothing in that list named an adapter installable on Windows,
// so the operator could not tell an unsupported lane from an unconfigured
// one (FN-015 rank 71). Every arm below names a road that exists on that
// host; the darwin text is the one the resolver above already promises.

/** The lldb-dap remedy for a host with neither lldb-dap nor gdb 14+. */
export function lldbDapInstallHint(platform: string = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'install the Xcode CommandLineTools (xcode-select --install) — they ship lldb-dap; older toolchains name it lldb-vscode'
    case 'win32':
      return 'install LLVM for Windows (winget install LLVM.LLVM, or the llvm.org installer) — its bin directory ships lldb-dap.exe (LLVM 18+); put it on PATH — or gdb 14+ from MSYS2 (pacman -S mingw-w64-ucrt-x86_64-gdb) for -i=dap'
    default:
      return 'install lldb from your distribution (apt install lldb · dnf install lldb) — the package ships lldb-dap (older releases name it lldb-vscode) — or gdb 14+ for -i=dap'
  }
}

/** The netcoredbg remedy: brew on macOS, the release archives elsewhere. */
export function netcoredbgInstallHint(platform: string = process.platform): string {
  return platform === 'darwin'
    ? 'brew install netcoredbg (or the Samsung/netcoredbg releases)'
    : 'download netcoredbg from github.com/Samsung/netcoredbg/releases (the Windows and Linux archives ship the netcoredbg binary) and put it on PATH'
}

/** The gdb 14+ remedy; MSYS2 carries the Windows build. */
export function gdbInstallHint(platform: string = process.platform): string {
  return platform === 'win32'
    ? 'install gdb 14+ from MSYS2 (pacman -S mingw-w64-ucrt-x86_64-gdb) — the first release with the native -i=dap interpreter'
    : 'install gdb 14+ (the first release with the native -i=dap interpreter)'
}

function builtinAdapters(): Record<string, () => DapAdapterSpec> {
  const table: Record<string, () => DapAdapterSpec> = {
    python: () => ({ ...pythonAdapterSpec(), attachShape: 'connect', fileTypes: ['.py'] }),
    lldb: () => {
      const resolved = resolveLldbDap()
      return {
        command: resolved?.path ?? 'lldb-dap',
        args: [],
        installHint: resolved
          ? `lldb-dap via ${resolved.source === 'xcrun' ? 'the darwin toolchain (xcrun -f lldb-dap)' : 'PATH'}: ${resolved.path}`
          : lldbDapInstallHint(),
      }
    },
  }
  // Go: dlv speaks DAP as a listening server (`dlv dap --listen`) — the tcp
  // shape with the substituted loopback port. Binary-gated.
  if (findOnPathLocal('dlv')) {
    table.go = () => ({
      command: 'dlv',
      args: ['dap', '--listen=127.0.0.1:${port}'],
      connect: 'tcp',
      fileTypes: ['.go'],
      rootMarkers: ['go.mod'],
      installHint: 'go install github.com/go-delve/delve/cmd/dlv@latest',
    })
  }
  // JS/TS: the js-debug DAP server (the TCP debug-server pattern), resolved
  // through the provenance ladder — env override, the vendored bundle, the
  // legacy ~/.js-debug unpack. Multi-session: the child-session road
  // (startDebugging) carries the actual debuggee.
  const jsDebug = resolveJsDebugServer()
  if (jsDebug) {
    table.js = () => ({
      command: process.execPath,
      args: [jsDebug.path, '${port}', '127.0.0.1'],
      connect: 'tcp',
      fileTypes: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'],
      rootMarkers: ['package.json'],
      // js-debug refuses a config without its `type` discriminator
      // ("Error: Unknown config: {...}" — live-driven finding; the road was
      // written against the generic body and gate boxes carry no
      // ~/.js-debug, so nothing ever saw the refusal). 'pwa-node' is the
      // standalone DAP server's node-debug type.
      launchDefaults: { type: 'pwa-node' },
      attachDefaults: { type: 'pwa-node' },
      installHint: `js-debug via ${jsDebugSourceLabel(jsDebug.source)}: ${jsDebug.path}`,
    })
  }
  // .NET: netcoredbg speaks stdio DAP directly. Binary-gated.
  if (findOnPathLocal('netcoredbg')) {
    table.dotnet = () => ({
      command: 'netcoredbg',
      args: ['--interpreter=vscode'],
      fileTypes: ['.cs'],
      rootMarkers: ['*.csproj', '*.sln'],
      installHint: netcoredbgInstallHint(),
    })
  }
  // Ruby: rdbg HOSTS the debuggee (`rdbg --open --port P -- program`), then
  // the client connects and sends attach — startRequest pins that.
  if (findOnPathLocal('rdbg')) {
    table.ruby = () => ({
      command: 'rdbg',
      args: ['--open', '--port', '${port}', '--stop-at-load', '--', '${program}'],
      connect: 'tcp',
      startRequest: 'attach',
      fileTypes: ['.rb'],
      rootMarkers: ['Gemfile'],
      installHint: 'gem install debug (provides rdbg)',
    })
  }
  // The gdb row exists only when PROBED viable (the godot conditional-row
  // pattern) — an unviable gdb never paints a launchable adapter.
  const gdb = probeGdbDap()
  if (gdb.viable) {
    table.gdb = () => ({
      command: 'gdb',
      args: ['-i=dap'],
      installHint: `gdb ${gdb.version ?? ''} -i=dap (native DAP floor: gdb ${GDB_DAP_MIN_MAJOR}+)`.trim(),
    })
  } else if (gdb.reason && gdb.reason !== 'no gdb on PATH') {
    logForDebugging(`dap: gdb adapter not registered: ${gdb.reason}`)
  }
  if (mercuryGodotEnabled()) {
    const port = godotDapPort()
    const hint = godotEditorHint(port)
    const bridge = godotBridgeCommand(port, hint)
    if (!('reason' in bridge)) {
      table[GODOT_DAP_ADAPTER_KEY] = () => ({
        command: bridge.command,
        args: bridge.args,
        installHint: hint,
        buildLaunchArgs: godotLaunchArgs,
      })
    } else {
      logForDebugging(`dap: godot adapter unavailable: ${bridge.reason}`)
    }
  }
  // Unity: attach-to-editor over the vstuc DAP adapter (the editor HOSTS
  // the debuggee — startRequest pins every gesture to attach). Row exists
  // only when the lane is armed (MERCURY_UNITY) AND the adapter resolved;
  // .cs joins the auto-pick ladder AFTER dotnet by insertion order (a bare
  // .cs on a netcoredbg box keeps dotnet; the Unity-project preference is
  // the root-marker-gated inferAdapter branch).
  if (mercuryUnityEnabled()) {
    const unity = resolveUnityDebugAdapter()
    if (!('reason' in unity)) {
      table[UNITY_DAP_ADAPTER_KEY] = () => ({
        command: unity.dotnet,
        args: [unity.dll],
        startRequest: 'attach',
        fileTypes: ['.cs'],
        rootMarkers: ['Assets', 'ProjectSettings'],
        installHint: `${unityEditorHint()} (adapter: ${unity.source} ${unity.dll})`,
        buildAttachArgs: buildUnityAttachArgs,
      })
    } else {
      logForDebugging(`dap: unity adapter unavailable: ${unity.reason}`)
    }
  }
  return table
}

/**
 * CHEAP adapter-reachability census over the live adapter table — fs stats,
 * memoized resolvers and 30s-cached probes ONLY, never an interpreter spawn
 * (the harness map's per-turn delta reads this; a starved gate fires late).
 * The conditional builtin rows (go/js/dotnet/ruby/gdb/godot) exist only when
 * their backing resolved, so their presence IS reachability; the two
 * unconditional rows are verified cheaply — `python` counts when the
 * vendored debugpy tree sits beside the artifact AND a python binary is on
 * PATH (an installed-module-only debugpy needs the import probe this
 * deliberately never pays — it under-claims there and the launch path stays
 * the truth), `lldb` counts when the shared resolver found a binary.
 * Operator env/file rows count by authorship.
 */
export function reachableDapAdapterKeys(): string[] {
  const reachable: string[] = []
  try {
    const table = builtinAdapters()
    for (const key of Object.keys(table)) {
      if (key === 'python') {
        if (
          debugpyVendorRoot() !== null &&
          (findOnPathLocal('python3') !== undefined || findOnPathLocal('python') !== undefined)
        ) {
          reachable.push(key)
        }
      } else if (key === 'lldb') {
        if (resolveLldbDap() !== null) reachable.push(key)
      } else {
        reachable.push(key)
      }
    }
    for (const key of Object.keys(fileAdapterTable())) {
      if (!reachable.includes(key)) reachable.push(key)
    }
    const raw = flagEnv('MERCURY_DAP_ADAPTERS')
    if (raw) {
      try {
        for (const key of Object.keys(JSON.parse(raw) as Record<string, unknown>)) {
          if (!reachable.includes(key)) reachable.push(key)
        }
      } catch {
        /* malformed table never breaks the census */
      }
    }
  } catch {
    /* a census failure claims nothing — the launch path stays the truth */
  }
  return reachable.sort()
}

export function mercuryDapEnabled(): boolean {
  return flagEnabled('MERCURY_DAP')
}

/** Catalog gate for tools.ts — default-on, flag-killable (MERCURY_DAP=0). */
export function isDapToolCatalogEnabled(): boolean {
  return mercuryDapEnabled()
}

// Bundle-sibling resolution (the ripgrep/debugpy idiom): in the built
// artifact import.meta.url is dist/mercury.mjs, so vendor/ sits beside the
// running file; in dev (bun over src/) the computed dir carries no vendor
// tree and the ladder falls through to the legacy unpack.
const __dapFilename = fileURLToPath(import.meta.url)
const __dapDirname = path.join(__dapFilename, '../')

export interface JsDebugResolution {
  path: string
  source: 'env-override' | 'vendored' | 'user-dir'
}

/** js-debug's DAP server script — the resolver LADDER, provenance-carrying:
 *  1. MERCURY_JS_DEBUG_DAP (an explicit pin is exclusive — a missing pinned
 *     file refuses honestly, never a silent substitute),
 *  2. the VENDORED tree beside the built artifact (dist/vendor/js-debug —
 *     pinned release, build-verified; the out-of-the-box road),
 *  3. the legacy user-dir unpack ~/.js-debug (the pre-vendor install road,
 *     kept as an honest fallback).
 *  Exported for /health's lane:dap:js row — the same resolution the adapter
 *  row uses, so evidence and launch behavior agree. */
export function resolveJsDebugServer(): JsDebugResolution | null {
  const pinned = flagEnv('MERCURY_JS_DEBUG_DAP')
  if (pinned && pinned.length > 0) {
    return existsSync(pinned) ? { path: pinned, source: 'env-override' } : null
  }
  const vendored = path.resolve(__dapDirname, 'vendor', 'js-debug', 'src', 'dapDebugServer.js')
  if (existsSync(vendored)) return { path: vendored, source: 'vendored' }
  const unpacked = join(homedir(), '.js-debug', 'src', 'dapDebugServer.js')
  return existsSync(unpacked) ? { path: unpacked, source: 'user-dir' } : null
}

/** The one human spelling per ladder rung (adapter hints + /health rows). */
export function jsDebugSourceLabel(source: JsDebugResolution['source']): string {
  return source === 'vendored'
    ? 'the vendored bundle'
    : source === 'env-override'
      ? 'MERCURY_JS_DEBUG_DAP'
      : 'the ~/.js-debug unpack'
}

/** One env/file table row, validated field-by-field (a typo never breaks
 *  the tool — invalid rows are skipped). */
function decodeAdapterRow(spec: unknown): DapAdapterSpec | null {
  if (!spec || typeof spec !== 'object') return null
  const s = spec as Record<string, unknown>
  if (typeof s.command !== 'string' || s.command.length === 0) return null
  const out: DapAdapterSpec = {
    command: s.command,
    args: Array.isArray(s.args) ? s.args.map(String) : [],
  }
  if (typeof s.installHint === 'string') out.installHint = s.installHint
  if (s.connect === 'tcp' || s.connect === 'stdio') out.connect = s.connect
  if (Array.isArray(s.fileTypes)) out.fileTypes = s.fileTypes.map(String)
  if (Array.isArray(s.rootMarkers)) out.rootMarkers = s.rootMarkers.map(String)
  if (s.launchDefaults && typeof s.launchDefaults === 'object' && !Array.isArray(s.launchDefaults)) {
    out.launchDefaults = s.launchDefaults as Record<string, unknown>
  }
  if (s.attachDefaults && typeof s.attachDefaults === 'object' && !Array.isArray(s.attachDefaults)) {
    out.attachDefaults = s.attachDefaults as Record<string, unknown>
  }
  if (s.attachShape === 'connect' || s.attachShape === 'flat') out.attachShape = s.attachShape
  if (s.startRequest === 'launch' || s.startRequest === 'attach') out.startRequest = s.startRequest
  return out
}

/** The adapter config FILE: <configHome>/dap-adapters.json (the
 *  MERCURY_DAP_ADAPTERS_FILE value pin is the hermetic proof seam). Parsed
 *  per call — the file is tiny and authority toggles stay live. */
function fileAdapterTable(): Record<string, DapAdapterSpec> {
  const pinned = flagEnv('MERCURY_DAP_ADAPTERS_FILE')
  const filePath =
    pinned && pinned.length > 0 ? pinned : join(getMercuryHome(), 'dap-adapters.json')
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    logForDebugging(`dap: ${filePath} is not valid JSON — ignored (${String(e)})`)
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, DapAdapterSpec> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const row = decodeAdapterRow(value)
    if (row) out[key] = row
    else logForDebugging(`dap: adapter-config row '${key}' invalid — skipped`)
  }
  return out
}

/** Resolve an adapter by key: env table (MERCURY_DAP_ADAPTERS) over the
 *  config file over builtins. */
export function resolveAdapter(key: string): DapAdapterSpec | null {
  const raw = flagEnv('MERCURY_DAP_ADAPTERS')
  if (raw) {
    try {
      const table = JSON.parse(raw) as Record<string, unknown>
      const row = decodeAdapterRow(table?.[key])
      if (row) return row
    } catch {
      // Malformed table ⇒ fall through; never break the tool.
    }
  }
  const fromFile = fileAdapterTable()[key]
  if (fromFile) return fromFile
  return builtinAdapters()[key]?.() ?? null
}

/**
 * The DORMANT builtin lanes: adapters the product knows how to drive whose
 * backing is absent on this machine, each with its one-line arm remedy. The
 * conditional rows simply not existing made them INVISIBLE — `unknown
 * adapter 'js'` and a doctor with no js/go/dotnet/ruby row taught nothing
 * about lanes one install away (the absent-adapter visibility asymmetry:
 * lldb/gdb had unavailable rows, the rest had silence).
 */
export function dormantBuiltinAdapterHints(): Array<{ key: string; hint: string }> {
  const table = builtinAdapters()
  const out: Array<{ key: string; hint: string }> = []
  if (!('js' in table)) {
    out.push({
      key: 'js',
      hint: 'rebuild with the vendored js-debug (bun run scripts/vendor/fetch-js-debug.ts && bun run build.ts), point MERCURY_JS_DEBUG_DAP at dapDebugServer.js, or unpack js-debug-dap to ~/.js-debug',
    })
  }
  if (!('go' in table)) {
    out.push({ key: 'go', hint: 'go install github.com/go-delve/delve/cmd/dlv@latest' })
  }
  if (!('dotnet' in table)) {
    out.push({ key: 'dotnet', hint: netcoredbgInstallHint() })
  }
  if (!('ruby' in table)) {
    out.push({ key: 'ruby', hint: 'gem install debug (provides rdbg)' })
  }
  if (!('gdb' in table)) {
    out.push({ key: 'gdb', hint: gdbInstallHint() })
  }
  // Opt-in engine rows hint ONLY while armed (off = no row, no hint —
  // the boot-menu off contract).
  if (mercuryUnityEnabled() && !(UNITY_DAP_ADAPTER_KEY in table)) {
    out.push({ key: UNITY_DAP_ADAPTER_KEY, hint: UNITY_ADAPTER_ARM_HINT })
  }
  return out
}

export function knownAdapterKeys(): string[] {
  const keys = new Set(Object.keys(builtinAdapters()))
  for (const k of Object.keys(fileAdapterTable())) keys.add(k)
  const raw = flagEnv('MERCURY_DAP_ADAPTERS')
  if (raw) {
    try {
      for (const k of Object.keys(JSON.parse(raw) as Record<string, unknown>)) {
        keys.add(k)
      }
    } catch {
      /* ignore */
    }
  }
  return [...keys].sort()
}

/** Extension → adapter auto-pick across every source (env > file >
 *  builtin), for inferAdapter. Returns the adapter key or null. */
export function adapterKeyForExtension(ext: string): string | null {
  const raw = flagEnv('MERCURY_DAP_ADAPTERS')
  if (raw) {
    try {
      const table = JSON.parse(raw) as Record<string, unknown>
      for (const [key, value] of Object.entries(table)) {
        const row = decodeAdapterRow(value)
        if (row?.fileTypes?.includes(ext)) return key
      }
    } catch {
      /* ignore */
    }
  }
  for (const [key, row] of Object.entries(fileAdapterTable())) {
    if (row.fileTypes?.includes(ext)) return key
  }
  for (const [key, make] of Object.entries(builtinAdapters())) {
    try {
      if (make().fileTypes?.includes(ext)) return key
    } catch {
      /* a throwing builtin never breaks the scan */
    }
  }
  return null
}

type Pending = {
  resolve: (body: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  command: string
}

/** The one client-capability surface, shared by root and child sessions:
 *  supportsStartDebuggingRequest arms the multi-session road (js-debug's
 *  per-target children, debugpy's subprocesses); runInTerminal stays refused
 *  — Mercury runs debuggees in-process, and the refusal is a typed
 *  success:false response, never a dropped frame. */
const CLIENT_INIT_ARGS = {
  clientID: 'mercury',
  linesStartAt1: true,
  columnsStartAt1: true,
  pathFormat: 'path',
  supportsRunInTerminalRequest: false,
  supportsStartDebuggingRequest: true,
} as const

// Child-session bounds (per tree): a runaway adapter cannot fan a session
// tree out unboundedly. A refused child answers success:false NAMING the
// bound AND rings one honest line — never a silent drop.
const CHILD_SESSION_MAX_DEFAULT = 16
const CHILD_SESSION_DEPTH_MAX_DEFAULT = 4
let childSessionMax = CHILD_SESSION_MAX_DEFAULT
let childSessionDepthMax = CHILD_SESSION_DEPTH_MAX_DEFAULT

/** TEST-ONLY: shrink the child-session bounds (bound-refusal proofs). */
export function _setDapChildBoundsForTesting(
  maxChildren = CHILD_SESSION_MAX_DEFAULT,
  maxDepth = CHILD_SESSION_DEPTH_MAX_DEFAULT,
): void {
  childSessionMax = maxChildren
  childSessionDepthMax = maxDepth
}

/** Monotonic stop recency (tree routing prefers the LATEST stop). */
let stopStamp = 0

export type StoppedInfo = {
  reason: string
  threadId: number | undefined
  description?: string
}

const REQUEST_TIMEOUT_MS = 8_000
/** setBreakpoints waits out cold symbol or source-map loading (FN-015
 *  rank 70); the generic deadline above killed the whole launch instead. */
const BREAKPOINT_REQUEST_TIMEOUT_MS = 30_000
const OUTPUT_RING_MAX = 200

export class DapSession {
  readonly adapterKey: string
  readonly program: string
  #spec: DapAdapterSpec
  #cwd: string
  /** Null for 'dial' children — their whole life is a second connection to
   *  the tree root's shared tcp server; there is no process of their own. */
  #child: ChildProcessWithoutNullStreams | null
  #socket: Socket | null = null
  /** tcp trees: the shared server's loopback port (children re-dial it). */
  #tcpPort: number | undefined
  /** Resolves when the wire (stdio pipes or the tcp socket) is writable. */
  #transportReady: Promise<void>
  #seq = 1
  #pending = new Map<number, Pending>()
  #buffer = Buffer.alloc(0)
  #initializedEvent: Promise<void>
  #resolveInitialized!: () => void
  /** Event-driven stop/termination waiters (replaces the 25ms
   *  poll): resolved by the message pump on 'stopped'/'terminated'/exit,
   *  and woken UP the tree — a child's stop wakes its ancestors' waiters. */
  #stateWaiters = new Set<() => void>()
  /** The launch-time requested breakpoints (tree root only) — every child
   *  session re-applies them at its configuration phase; in the
   *  multi-session shape the CHILD is the verifier. */
  #requestedBreakpoints: Map<string, Array<number | DapBreakpointSpec>> | null = null
  /** Child sessions the adapter started via startDebugging (direct only;
   *  tree walks recurse). */
  readonly children: DapSession[] = []
  /** Tree parent (null = root). */
  readonly parentSession: DapSession | null
  /** Status/ambiguity name: the alias for roots, the startDebugging
   *  configuration's name for children. */
  readonly label: string
  /** 0 for roots; bounded by the child-session depth cap. */
  readonly depth: number
  /** Monotonic stamp of the most recent 'stopped' event (tree routing). */
  lastStoppedAt = 0
  /** Most recent 'stopped' event; cleared by continue/step. */
  lastStopped: StoppedInfo | null = null
  terminated = false
  exitDetail = ''
  /** The adapter's initialize-response Capabilities —
   *  the honest gate for optional requests (modules, loadedSources,
   *  completions, setVariable, exception filters). Null until launch. */
  capabilities: Record<string, unknown> | null = null
  /** The start request this session sent: 'launch' hosts a program Mercury
   *  started, 'attach' borrowed one already running. Null until the dance.
   *  The detach truth reads it — disposing an attach session leaves its
   *  target running (FN-015 rank 32). */
  startMode: 'launch' | 'attach' | null = null
  /** True once THIS session showed a debuggee of its own — a process,
   *  thread or stopped event on its wire. From then on its termination is
   *  its own word, never inferred from its children: the debugpy root hosts
   *  the main program while subprocess children come and go; only a pure
   *  server root (js-debug's parent, which never runs a program) dies with
   *  its last child (FN-015 rank 34). */
  #hostsDebuggee = false
  /** Ring buffer of adapter/debuggee output lines. */
  output: string[] = []
  /** Per-source breakpoints (path → verified detail) so status can report
   *  what the ADAPTER confirmed, not just what was requested. `id` is the
   *  adapter's breakpoint id when it gave one — the join key for later
   *  breakpoint-changed events (lazy verifiers like js-debug answer
   *  setBreakpoints UNVERIFIED and flip verified once the source loads). */
  breakpoints = new Map<string, Array<{ line: number; verified: boolean; message?: string; id?: number }>>()

  constructor(
    adapterKey: string,
    spec: DapAdapterSpec,
    program: string,
    cwd: string,
    /** tcp: the loopback port — 'spawn' listens there, 'dial' re-dials it. */
    tcpPort?: number,
    /** 'spawn' (default) starts an adapter process; 'dial' is the tcp
     *  child-session arm — no process, a second connection to the tree
     *  root's shared server (the js-debug dapDebugServer contract). */
    wire: 'spawn' | 'dial' = 'spawn',
    /** Child sessions carry their parent + display label; roots their alias. */
    treeInit?: { parent: DapSession | null; label: string },
  ) {
    this.adapterKey = adapterKey
    this.program = program
    this.#spec = spec
    this.#cwd = cwd
    this.#tcpPort = tcpPort
    this.parentSession = treeInit?.parent ?? null
    this.label = treeInit?.label ?? adapterKey
    this.depth = this.parentSession ? this.parentSession.depth + 1 : 0
    this.#initializedEvent = new Promise(res => {
      this.#resolveInitialized = res
    })
    // The tree shares ONE output ring — a child's debuggee output lands
    // where the operator is already looking (per-wire reassembly stays
    // per-session in #partialOutput).
    if (this.parentSession) this.output = this.parentSession.root().output
    if (wire === 'dial') {
      this.#child = null
      if (tcpPort === undefined) {
        this.terminated = true
        this.exitDetail = 'dial session has no server port'
        this.#transportReady = Promise.reject(new Error(this.exitDetail))
        this.#transportReady.catch(() => {})
        return
      }
      this.#transportReady = this.#connectTcp(tcpPort)
      return
    }
    const child = spawn(spec.command, spec.args, {
      windowsHide: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The adapter tree gets NO controlling terminal: a new session on
      // POSIX (setsid). Pipes alone are not enough — a debug launcher
      // opens /dev/tty by name and hands the terminal's foreground process
      // group to the debuggee (debugpy's launcher does exactly this), and
      // when the debuggee exits nothing hands it back; this process is then
      // a background job of its own terminal, and its next read of the
      // keyboard stops it (SIGTTIN, "suspended (tty input)") with every
      // terminal mode still armed. With no controlling terminal the
      // /dev/tty open fails and the launcher skips the hand-off. The
      // detached leader also makes the tree kill a group kill.
      detached: process.platform !== 'win32',
      // W7-E (L19): adapters (and their debuggees) execute the
      // vendored python tree — the byte-stability env routes bytecode into
      // the build-keyed runtime cache instead of the managed payload.
      env: pythonSpawnEnv(),
    })
    this.#child = child
    if (spec.connect === 'tcp' && tcpPort !== undefined) {
      // The tcp shape (dlv dap, js-debug's DAP server): the child LISTENS on
      // the substituted loopback port; frames ride a socket. The child's own
      // pipes only feed the output ring.
      child.stdout.on('data', (chunk: Buffer) => {
        this.#pushOutput(`[adapter] ${String(chunk).trimEnd()}`)
      })
      this.#transportReady = this.#connectTcp(tcpPort)
    } else {
      child.stdout.on('data', (chunk: Buffer) => this.#onData(chunk))
      this.#transportReady = Promise.resolve()
    }
    child.stderr.on('data', (chunk: Buffer) => {
      this.#pushOutput(`[adapter] ${String(chunk).trimEnd()}`)
    })
    child.on('exit', (code, signal) => {
      this.terminated = true
      this.exitDetail = `adapter exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer)
        p.reject(new Error(this.exitDetail))
      }
      this.#pending.clear()
      this.#wakeStateWaiters()
    })
    child.on('error', err => {
      this.terminated = true
      this.exitDetail = `adapter failed to start: ${err.message}`
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer)
        p.reject(new Error(this.exitDetail))
      }
      this.#pending.clear()
      this.#wakeStateWaiters()
    })
  }

  #wakeStateWaiters(): void {
    for (const wake of [...this.#stateWaiters]) {
      try {
        wake()
      } catch {
        /* waiter errors never break the pump */
      }
    }
    // A child's state change is tree news — ancestors' waiters re-read the
    // tree (waitForStopOutcome routes to the stopped member).
    if (this.parentSession) this.parentSession.#wakeStateWaiters()
  }

  // ── the session tree (multi-session adapters) ──────────────────────────

  /** The tree root (self when this session has no parent). */
  root(): DapSession {
    let s: DapSession = this
    while (s.parentSession) s = s.parentSession
    return s
  }

  /** Self + every descendant, pre-order. */
  treeSessions(): DapSession[] {
    const out: DapSession[] = [this]
    for (const child of this.children) out.push(...child.treeSessions())
    return out
  }

  treeSize(): number {
    return this.treeSessions().length
  }

  /** The tree member holding the MOST RECENT 'stopped' event (single-session
   *  trees degenerate to today's self-check, stale-stop edge included).
   *  `sinceStamp` filters to stops NEWER than a captured stamp — the honest
   *  step-wait in a tree where another member still holds an older stop. */
  treeStopped(sinceStamp = 0): DapSession | null {
    let best: DapSession | null = null
    for (const s of this.treeSessions()) {
      if (s.lastStopped && s.lastStoppedAt > sinceStamp && (best === null || s.lastStoppedAt > best.lastStoppedAt)) {
        best = s
      }
    }
    return best
  }

  /** The newest stop stamp anywhere in the tree (0 = never stopped) —
   *  capture BEFORE continue/step/pause, then wait for a stop newer than it. */
  treeNewestStopStamp(): number {
    let max = 0
    for (const s of this.treeSessions()) {
      if (s.lastStoppedAt > max) max = s.lastStoppedAt
    }
    return max
  }

  /** The tree-merged breakpoint truth, index-aligned per path (every member
   *  applies the SAME requested set): a line is verified when ANY member
   *  verified it — in the multi-session shape the parent honestly reports
   *  unverified and the CHILD is the verifier, named per line. */
  treeVerifiedBreakpoints(): Map<
    string,
    Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>
  > {
    const out = new Map<string, Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>>()
    for (const s of this.treeSessions()) {
      for (const [path, rows] of s.breakpoints) {
        const cur = out.get(path)
        if (!cur) {
          out.set(
            path,
            rows.map(r => ({ ...r, ...(r.verified ? { verifier: s.label } : {}) })),
          )
          continue
        }
        rows.forEach((r, i) => {
          const prev = cur[i]
          if (!prev) cur[i] = { ...r, ...(r.verified ? { verifier: s.label } : {}) }
          else if (!prev.verified && r.verified) cur[i] = { ...r, verifier: s.label }
        })
      }
    }
    return out
  }

  /** Set breakpoints across the WHOLE tree and remember them as the
   *  requested set (children arriving later inherit them). Returns the
   *  merged verification truth for the path. Per-member failures ring —
   *  never silent. */
  async setBreakpointsTree(
    path: string,
    breakpoints: Array<number | DapBreakpointSpec>,
  ): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>> {
    const root = this.root()
    if (!root.#requestedBreakpoints) root.#requestedBreakpoints = new Map()
    root.#requestedBreakpoints.set(path, breakpoints)
    for (const s of root.treeSessions()) {
      if (!s.alive) continue
      try {
        await s.setBreakpoints(path, breakpoints)
      } catch (err) {
        this.#pushOutput(`[dap] breakpoints for ${path} on '${s.label}' failed: ${(err as Error).message}`)
      }
    }
    return root.treeVerifiedBreakpoints().get(path) ?? []
  }

  /** Debuggee-termination truth for the tree: the root terminated, OR every
   *  child terminated (js-debug's parent may linger as a server session
   *  after its last target exits — the debuggee is still gone; a LATER
   *  child would re-arm nothing, which status reports honestly). */
  treeTerminated(): boolean {
    if (this.terminated) return true
    // A member with a debuggee of its own answers for itself (the debugpy
    // root runs the main program; a worker child's exit is not the
    // program's) — the children rule is for pure server members only.
    if (this.#hostsDebuggee) return false
    return this.children.length > 0 && this.children.every(c => c.treeTerminated())
  }

  /**
   * The tree member that owns the debuggee conversation right now: the most
   * recently stopped member, else the LONE live descendant, else self when
   * childless. MULTIPLE live descendants with none stopped is ambiguous and
   * answers TYPED — naming every member and its state — never a silent
   * guess (a debuggee-facing op routed to the wrong session lies quietly).
   */
  debugTarget(): { session: DapSession } | { ambiguousDetail: string } {
    const stopped = this.treeStopped()
    if (stopped) return { session: stopped }
    const liveDescendants = this.treeSessions().filter(s => s !== this && s.alive)
    if (liveDescendants.length === 1) {
      const only = liveDescendants[0]
      if (only) return { session: only }
    }
    if (liveDescendants.length === 0) return { session: this }
    const listing = this.treeSessions()
      .map(
        s =>
          `${s.label}: ${s.terminated ? 'terminated' : s.lastStopped ? `stopped (${s.lastStopped.reason})` : 'running'}`,
      )
      .join(' · ')
    return {
      ambiguousDetail:
        `${liveDescendants.length} child sessions are live and none is stopped — refusing to guess a target. ` +
        `tree: ${listing}. Wait for a stop (op:"status" shows the tree), or op:"disconnect" to end the session`,
    }
  }

  /** Bounded loopback connect with retry — the spawned server needs a
   *  moment to bind its port; a dead child fails the wait immediately. */
  async #connectTcp(port: number, deadlineMs = 6_000): Promise<void> {
    // 6s BY DESIGN — a step ahead of REQUEST_TIMEOUT_MS (8s): a tcp adapter
    // that never binds must lose its race BEFORE the first request's
    // generic timer, or the precise 'adapter never opened 127.0.0.1:<port>'
    // diagnostic composed below can never reach the operator and every
    // transport failure reads 'initialize timed out — no evidence either
    // way' (FC-104), a protocol diagnosis for a transport failure.
    const start = Date.now()
    for (;;) {
      if (this.terminated) throw new Error(this.exitDetail || 'adapter exited before the tcp port opened')
      const socket = await new Promise<Socket | null>(resolve => {
        const s = netConnect({ host: '127.0.0.1', port }, () => resolve(s))
        s.on('error', () => resolve(null))
      })
      if (socket) {
        this.#socket = socket
        socket.on('data', (chunk: Buffer) => this.#onData(chunk))
        socket.on('close', () => {
          if (!this.terminated) {
            this.terminated = true
            this.exitDetail = this.exitDetail || 'adapter socket closed'
            this.#wakeStateWaiters()
          }
        })
        socket.on('error', () => {
          /* close follows; the pump settles there */
        })
        return
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(`adapter never opened 127.0.0.1:${port} within ${deadlineMs}ms`)
      }
      await new Promise(r => setTimeout(r, 100))
    }
  }

  get alive(): boolean {
    return !this.terminated && (this.#child === null || this.#child.exitCode === null)
  }

  #pushOutput(line: string): void {
    this.output.push(line)
    if (this.output.length > OUTPUT_RING_MAX) {
      this.output.splice(0, this.output.length - OUTPUT_RING_MAX)
    }
  }

  /** DAP 'output' events are STREAM CHUNKS, not lines — under load debugpy
   *  splits a single print across events ("result:" + " 47\n"), so the ring
   *  must reassemble on newlines or readers see broken lines (the
   *  load-surfaced defect). Complete lines join the ring; the
   *  remainder waits for its newline (flushed on termination/drain).
   * `\r` is a boundary too (tqdm/pip progress emit
   *  \r-terminated frames and never a \n while the debuggee free-runs), the
   *  partial buffer keeps only a bounded TAIL, and ring lines are clamped —
   *  a runaway debuggee cannot balloon the host. */
  #partialOutput = ''
  static readonly #PARTIAL_OUTPUT_KEEP_BYTES = 64 * 1024
  static readonly #RING_LINE_MAX_CHARS = 4_096
  #pushOutputChunk(chunk: string): void {
    this.#partialOutput += chunk
    for (;;) {
      const nl = this.#partialOutput.search(/[\r\n]/)
      if (nl === -1) break
      const line = this.#partialOutput.slice(0, nl).trimEnd()
      // Swallow a \r\n pair as one boundary.
      const next = this.#partialOutput[nl] === '\r' && this.#partialOutput[nl + 1] === '\n' ? nl + 2 : nl + 1
      this.#partialOutput = this.#partialOutput.slice(next)
      if (line) this.#pushOutput(line)
    }
    if (this.#partialOutput.length > DapSession.#PARTIAL_OUTPUT_KEEP_BYTES) {
      this.#partialOutput = this.#partialOutput.slice(-DapSession.#PARTIAL_OUTPUT_KEEP_BYTES)
    }
  }

  /** Promote any trailing un-newlined output into the ring (termination,
   *  drain, dispose — a debuggee's last write may lack a newline). */
  flushPartialOutput(): void {
    const rest = this.#partialOutput.trimEnd()
    this.#partialOutput = ''
    if (rest) this.#pushOutput(rest)
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.#buffer.subarray(0, headerEnd).toString('utf-8')
      const m = header.match(/Content-Length:\s*(\d+)/i)
      if (!m || m[1] === undefined) {
        // Unparseable header — drop through it rather than wedging the stream.
        this.#buffer = this.#buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(m[1])
      const start = headerEnd + 4
      if (this.#buffer.length < start + length) return
      const body = this.#buffer.subarray(start, start + length).toString('utf-8')
      this.#buffer = this.#buffer.subarray(start + length)
      try {
        this.#onMessage(JSON.parse(body) as Record<string, unknown>)
      } catch {
        logForDebugging(`dap: unparseable message body (${length} bytes)`)
      }
    }
  }

  #onMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'request') {
      // REVERSE requests (adapter → client). Silently dropping these was THE
      // js-debug boundary: the parent's startDebugging went unanswered, the
      // launch was accepted, and no debuggee ever ran.
      this.#onReverseRequest(msg)
      return
    }
    if (msg.type === 'response') {
      const reqSeq = Number(msg.request_seq)
      const pending = this.#pending.get(reqSeq)
      if (!pending) return
      this.#pending.delete(reqSeq)
      clearTimeout(pending.timer)
      if (msg.success) {
        pending.resolve((msg.body as Record<string, unknown>) ?? {})
      } else {
        pending.reject(
          new Error(
            `${pending.command} failed: ${String(msg.message ?? 'unknown adapter error')}`,
          ),
        )
      }
      return
    }
    if (msg.type === 'event') {
      const body = (msg.body as Record<string, unknown>) ?? {}
      switch (msg.event) {
        case 'initialized':
          this.#resolveInitialized()
          break
        case 'process':
        case 'thread':
          // A debuggee of this session's own (FN-015 rank 34).
          this.#hostsDebuggee = true
          break
        case 'stopped':
          this.#hostsDebuggee = true
          this.lastStopped = {
            reason: String(body.reason ?? 'unknown'),
            threadId: typeof body.threadId === 'number' ? body.threadId : undefined,
            description:
              typeof body.description === 'string' ? body.description : undefined,
          }
          this.lastStoppedAt = ++stopStamp
          this.#wakeStateWaiters()
          break
        case 'continued':
          this.lastStopped = null
          break
        case 'output': {
          // Telemetry events (debugpy's ptvsd/debugpy package pings) are
          // adapter chrome, not program output — keep the ring honest.
          if (body.category === 'telemetry') break
          this.#pushOutputChunk(String(body.output ?? ''))
          break
        }
        case 'breakpoint': {
          // Lazy verifiers (js-debug — the live drill's finding) answer
          // setBreakpoints UNVERIFIED and verify through breakpoint-changed
          // events once the source loads; fold them into this session's map
          // (id join first, line fallback) so the merged tree truth catches
          // up with what the stop already proves.
          const bp =
            (body.breakpoint as { id?: number; line?: number; verified?: boolean; message?: string } | undefined) ?? {}
          for (const rows of this.breakpoints.values()) {
            for (const row of rows) {
              const idMatch = typeof bp.id === 'number' && row.id === bp.id
              const lineMatch = typeof bp.id !== 'number' && typeof bp.line === 'number' && row.line === bp.line
              if (idMatch || lineMatch) {
                if (bp.verified === true) row.verified = true
                if (typeof bp.line === 'number') row.line = bp.line
                if (typeof bp.message === 'string') row.message = bp.message
              }
            }
          }
          break
        }
        case 'terminated':
        case 'exited':
          this.terminated = true
          this.flushPartialOutput()
          if (msg.event === 'exited') {
            this.exitDetail = `debuggee exited (code ${String(body.exitCode ?? '?')})`
          }
          this.#wakeStateWaiters()
          break
        default:
          break
      }
    }
  }

  /** Frame one payload onto this session's wire (socket or stdio). */
  #writeFrame(payload: string, onError?: (err: Error) => void): void {
    const framed = `Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}`
    void this.#transportReady
      .then(() => {
        const wire = this.#socket ?? this.#child?.stdin
        if (!wire) throw new Error(this.exitDetail || 'session has no transport')
        wire.write(framed, err => {
          if (err) onError?.(err)
        })
      })
      .catch(err => onError?.(err as Error))
  }

  /** Answer a reverse request on the wire it arrived from — every reverse
   *  request gets a typed response (success:false for the unsupported), so
   *  an adapter never waits on a dropped frame. */
  #respondToReverse(request: Record<string, unknown>, success: boolean, message?: string): void {
    const payload = JSON.stringify({
      seq: this.#seq++,
      type: 'response',
      request_seq: Number(request.seq),
      command: String(request.command ?? ''),
      success,
      ...(message !== undefined ? { message } : {}),
      body: {},
    })
    this.#writeFrame(payload)
  }

  /** R2's bound law: the refusal names the bound; the caller rings it. */
  #childBoundRefusal(): string | null {
    if (this.root().treeSize() - 1 >= childSessionMax) {
      return `child-session bound reached (${childSessionMax} per tree) — op:"disconnect" and re-launch to reset`
    }
    if (this.depth + 1 > childSessionDepthMax) {
      return `child-session depth bound reached (${childSessionDepthMax}) — refusing a deeper session`
    }
    return null
  }

  /** Build (never start) the child session for a startDebugging request:
   *  tcp adapters re-dial the shared server (the js-debug contract — the
   *  child's connection is routed by the configuration's __pendingTargetId);
   *  stdio adapters get a fresh process of the same substituted spec (the
   *  debugpy-subprocess shape). */
  #createChildSession(configuration: Record<string, unknown>): DapSession {
    const label =
      typeof configuration.name === 'string' && configuration.name.length > 0
        ? configuration.name
        : `child-${this.root().treeSize()}`
    const program =
      typeof configuration.program === 'string' && configuration.program.length > 0
        ? configuration.program
        : this.program
    let child: DapSession
    if (this.#spec.connect === 'tcp') {
      if (this.#tcpPort === undefined) throw new Error('tcp adapter session has no known server port')
      child = new DapSession(this.adapterKey, this.#spec, program, this.#cwd, this.#tcpPort, 'dial', {
        parent: this,
        label,
      })
    } else {
      child = new DapSession(this.adapterKey, this.#spec, program, this.#cwd, undefined, 'spawn', {
        parent: this,
        label,
      })
    }
    this.children.push(child)
    return child
  }

  /** The child's own dance: initialize → the reverse request's launch/attach
   *  kind with the configuration VERBATIM (the adapter shaped it for its
   *  child — js-debug's __pendingTargetId rides here) → initialized → the
   *  root's requested breakpoints (the child is the verifier) →
   *  configurationDone → the start response. */
  async #runChildDance(
    requestKind: 'launch' | 'attach',
    configuration: Record<string, unknown>,
  ): Promise<void> {
    this.startMode = requestKind
    this.capabilities = await this.request('initialize', {
      ...CLIENT_INIT_ARGS,
      adapterID: this.adapterKey,
    })
    const startDone = this.request(requestKind, configuration, 20_000)
    // The same unhandled-rejection arming as the root dance — a throw below
    // abandons this in-flight request, and its later rejection must not
    // crash the host (the attach-drill lesson).
    startDone.catch(() => {})
    const sawInitialized = await Promise.race([
      this.#initializedEvent.then(() => true),
      new Promise<boolean>(res => setTimeout(() => res(false), 10_000)),
    ])
    if (!sawInitialized) {
      throw new Error(adapterSilenceMessage('child adapter never sent initialized (10s)', this.adapterKey))
    }
    const requested = this.root().#requestedBreakpoints
    if (requested) {
      for (const [path, lines] of requested) {
        await this.setBreakpoints(path, lines).catch(err =>
          this.#pushOutput(
            `[dap] child '${this.label}' breakpoints for ${path} failed: ${(err as Error).message}`,
          ),
        )
      }
    }
    await this.request('configurationDone').catch(() => {
      // Some adapters don't implement it; the start response is the truth.
    })
    await startDone
  }

  /** Adapter → client requests. startDebugging starts a child session (the
   *  multi-session road); runInTerminal and unknown commands answer typed
   *  success:false — never a dropped frame. */
  #onReverseRequest(msg: Record<string, unknown>): void {
    const command = String(msg.command ?? '')
    if (command === 'startDebugging') {
      const args = (msg.arguments as Record<string, unknown> | undefined) ?? {}
      const configuration = (args.configuration as Record<string, unknown> | undefined) ?? {}
      const requestKind: 'launch' | 'attach' = args.request === 'attach' ? 'attach' : 'launch'
      const refusal = this.#childBoundRefusal()
      if (refusal) {
        // R2: a refused child is typed AND ringed — a silently-dropped
        // child was the disease; a silently-refused one is its cousin.
        this.#respondToReverse(msg, false, refusal)
        this.#pushOutput(`[dap] refused startDebugging: ${refusal}`)
        return
      }
      let child: DapSession
      try {
        child = this.#createChildSession(configuration)
      } catch (e) {
        const reason = `child session could not start: ${(e as Error).message}`
        this.#respondToReverse(msg, false, reason)
        this.#pushOutput(`[dap] ${reason}`)
        return
      }
      // Respond once the child exists and its wire-up has begun (the
      // VS Code timing); a dance failure lands in the ring + tree state.
      this.#respondToReverse(msg, true)
      void child.#runChildDance(requestKind, configuration).catch(err => {
        this.#pushOutput(
          `[dap] child session '${child.label}' failed to start: ${(err as Error).message}`,
        )
        child.killSync()
      })
      return
    }
    if (command === 'runInTerminal') {
      this.#respondToReverse(
        msg,
        false,
        'Mercury runs debuggees in-process (supportsRunInTerminalRequest: false) — runInTerminal refused',
      )
      return
    }
    this.#respondToReverse(msg, false, `unsupported reverse request '${command}'`)
  }

  request(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (!this.alive && command !== 'disconnect') {
      return Promise.reject(new Error(this.exitDetail || 'session is not alive'))
    }
    const seq = this.#seq++
    const payload = JSON.stringify({ seq, type: 'request', command, arguments: args ?? {} })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(seq)
        reject(new Error(`${command} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#pending.set(seq, { resolve, reject, timer, command })
      const fail = (err: Error): void => {
        this.#pending.delete(seq)
        clearTimeout(timer)
        reject(err)
      }
      // The transport's own failure outranks the generic request timer
      // (FC-104): a request in flight while the tcp dial dies must speak
      // the dial's precise error, never a protocol-shaped timeout.
      void this.#transportReady.catch((err: unknown) => {
        if (this.#pending.has(seq)) fail(err instanceof Error ? err : new Error(String(err)))
      })
      this.#writeFrame(payload, fail)
    })
  }

  /** The standard DAP launch/attach dance. Resolves once configurationDone
   *  lands. mode 'attach' sends the standard attach body
   *  {pid?, program?} — same initialize→initialized→breakpoints→
   *  configurationDone choreography, different start request. */
  async launch(options: {
    program: string
    args?: string[]
    /** Runtime (interpreter) argv, for adapters whose launch grammar
     *  separates program args from runtime flags (js-debug pwa-node:
     *  node's own flags, e.g. --test-name-pattern). Only ever placed on
     *  the standard body when given — adapters without the field never
     *  see the key. */
    runtimeArgs?: string[]
    stopOnEntry?: boolean
    breakpoints?: Map<string, Array<number | DapBreakpointSpec>>
    mode?: 'launch' | 'attach'
    pid?: number
    /** attach-by-socket: the debuggee (or its agent) listens here. */
    port?: number
    host?: string
    /** DAP noDebug: RUN the program through the same
     *  adapter/session machinery without debugging — the unified
     *  launch-profile 'run' path (output ring + termination truth intact;
     *  breakpoints are ignored by contract). */
    noDebug?: boolean
  }): Promise<void> {
    // Kept for the tree: children arriving at ANY later moment re-apply
    // these (the multi-session parent binds nothing; the child verifies).
    this.#requestedBreakpoints = options.breakpoints ?? null
    this.capabilities = await this.request('initialize', {
      ...CLIENT_INIT_ARGS,
      adapterID: this.adapterKey,
    })
    // Many adapters hold the launch response until configurationDone — fire
    // it without awaiting, then complete the initialized→breakpoints→
    // configurationDone leg, then await the launch response. Adapters with a
    // bespoke launch contract (godot: {project, scene}) shape their own body
    // via the spec's buildLaunchArgs; everyone else gets the standard shape.
    // An adapter that HOSTS its debuggee (rdbg) forces its start request
    // via spec.startRequest.
    const attach = options.mode === 'attach' || this.#spec.startRequest === 'attach'
    this.startMode = attach ? 'attach' : 'launch'
    let startBody: Record<string, unknown>
    if (attach) {
      const host = options.host ?? '127.0.0.1'
      if (this.#spec.buildAttachArgs) {
        // Bespoke attach contract (unity: {type, endPoint, projectPath}) —
        // the builder owns the whole body, mirroring buildLaunchArgs.
        startBody = this.#spec.buildAttachArgs({
          program: options.program,
          cwd: this.#cwd,
          ...(options.host !== undefined ? { host: options.host } : {}),
          ...(options.port !== undefined ? { port: options.port } : {}),
          ...(options.pid !== undefined ? { pid: options.pid } : {}),
        })
      } else if (this.#spec.attachShape === 'connect' && options.port !== undefined) {
        // The debugpy spelling (contract data): {connect: {host, port}}.
        startBody = { ...(this.#spec.attachDefaults ?? {}), connect: { host, port: options.port } }
      } else {
        startBody = {
          ...(this.#spec.attachDefaults ?? {}),
          ...(options.pid !== undefined ? { pid: options.pid } : {}),
          ...(options.port !== undefined ? { port: options.port, host } : {}),
          ...(options.program && options.pid === undefined && options.port === undefined
            ? { program: options.program }
            : {}),
        }
      }
    } else {
      startBody = this.#spec.buildLaunchArgs?.({
        program: options.program,
        args: options.args,
        cwd: this.#cwd,
        stopOnEntry: options.stopOnEntry,
      }) ?? {
        ...(this.#spec.launchDefaults ?? {}),
        program: options.program,
        args: options.args ?? [],
        ...(options.runtimeArgs !== undefined ? { runtimeArgs: options.runtimeArgs } : {}),
        // The session's directory — the one the adapter itself was started
        // in, and the one the attach and buildLaunchArgs arms already pass.
        // process.cwd() here sent the debuggee to Mercury's startup
        // directory after any cd or cwd override (FN-015 rank 33).
        cwd: this.#cwd,
        stopOnEntry: options.stopOnEntry ?? false,
        noDebug: options.noDebug ?? false,
        console: 'internalConsole',
      }
    }
    const launchDone = this.request(attach ? 'attach' : 'launch', startBody, 20_000)
    // ARM a no-op rejection handler immediately: every throw between here
    // and the `await launchDone` below (the initialized timeout, a
    // breakpoint-round failure) abandons this in-flight request, and its
    // later rejection at dispose/killSync was an UNHANDLED rejection that
    // crashed the host process (surfaced by the attach drill: a dead
    // listener → initialized timeout → dispose → killSync rejects the
    // pending attach → crash). The real await still observes the rejection.
    launchDone.catch(() => {})
    // Guard the initialized event too — a wedged adapter must not hang the
    // tool. In noDebug mode the configuration phase may not EXIST: debugpy
    // (rightly) never sends `initialized` when there is nothing to configure
    // — so wait only briefly and skip the breakpoint/configurationDone dance
    // when it doesn't come (an adapter that does send it still gets the full
    // choreography).
    const initializedTimeoutMs = options.noDebug ? 2_000 : 10_000
    const sawInitialized = await Promise.race([
      this.#initializedEvent.then(() => true),
      new Promise<boolean>(res => setTimeout(() => res(false), initializedTimeoutMs)),
    ])
    if (!sawInitialized && !options.noDebug) {
      throw new Error(adapterSilenceMessage('adapter never sent initialized (10s)', this.adapterKey))
    }
    if (sawInitialized) {
      if (options.breakpoints && !options.noDebug) {
        for (const [path, lines] of options.breakpoints) {
          // Non-fatal, like setBreakpointsTree (FN-015 rank 70): one slow or
          // refused round used to abort the whole launch — configurationDone
          // never sent, the session disposed, "launch failed: setBreakpoints
          // timed out" with an output tail showing nothing wrong, and no
          // live session left to retry the binding on. The unbound lines
          // are recorded UNVERIFIED with the reason; the program runs.
          try {
            await this.setBreakpoints(path, lines)
          } catch (err) {
            this.#recordUnboundBreakpoints(path, lines, err)
          }
        }
      }
      await this.request('configurationDone').catch(() => {
        // Some adapters don't implement it; the launch response is the truth.
      })
    }
    await launchDone
  }

  /** A launch-time breakpoint round that failed (a refusal, a deadline):
   *  the lines are recorded UNVERIFIED carrying the reason, so the launch
   *  result and status name them, and the ring says so. */
  #recordUnboundBreakpoints(path: string, breakpoints: Array<number | DapBreakpointSpec>, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err)
    this.breakpoints.set(
      path,
      breakpoints.map(b => ({ line: typeof b === 'number' ? b : b.line, verified: false, message: `setBreakpoints failed: ${reason}` })),
    )
    this.#pushOutput(`[dap] breakpoints for ${path} on '${this.label}' failed: ${reason} — the program runs without them; op:"breakpoints" retries the binding`)
  }

  /** Set breakpoints and record what the adapter actually VERIFIED. Accepts
   *  plain line numbers (back-compat) or rich specs (
   *  condition/hitCondition/logMessage; the CALLER gates those on the
   *  adapter's advertised capabilities). */
  async setBreakpoints(
    path: string,
    breakpoints: Array<number | DapBreakpointSpec>,
  ): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number }>> {
    const specs: DapBreakpointSpec[] = breakpoints.map(b =>
      typeof b === 'number' ? { line: b } : b,
    )
    const body = await this.request(
      'setBreakpoints',
      {
        source: { path },
        breakpoints: specs.map(s => ({
          line: s.line,
          ...(s.condition !== undefined ? { condition: s.condition } : {}),
          ...(s.hitCondition !== undefined ? { hitCondition: s.hitCondition } : {}),
          ...(s.logMessage !== undefined ? { logMessage: s.logMessage } : {}),
        })),
        sourceModified: false,
      },
      // Sized for cold symbol loading — a large native binary or bundle on
      // a spinning disk — not the generic request deadline (FN-015 rank 70).
      BREAKPOINT_REQUEST_TIMEOUT_MS,
    )
    const reported = Array.isArray(body.breakpoints)
      ? (body.breakpoints as Array<{ verified?: boolean; line?: number; message?: string; id?: number }>)
      : []
    const verified = specs.map((s, i) => ({
      line: reported[i]?.line ?? s.line,
      verified: reported[i]?.verified === true,
      ...(typeof reported[i]?.id === 'number' ? { id: reported[i]?.id } : {}),
      ...(typeof reported[i]?.message === 'string' ? { message: reported[i]?.message } : {}),
    }))
    this.breakpoints.set(path, verified)
    return verified
  }

  /**
   * Wait until the debuggee reports stopped (breakpoint/step/entry), the
   * session terminates, or the deadline/abort fires. EVENT-DRIVEN:
   * the message pump wakes waiters on 'stopped'/'terminated'/exit — no poll
   * loop — and TREE-AWARE: a stop in any child routes here with the stopped
   * SESSION (multi-session adapters stop in their children), and
   * termination is the tree's debuggee truth. The outcome is honest:
   * 'stopped' with the info + session, 'terminated', or 'timeout'
   * (indeterminate — the debuggee may still be running).
   */
  async waitForStopOutcome(
    timeoutMs = 10_000,
    signal?: AbortSignal,
    /** Only stops NEWER than this stamp count (see treeNewestStopStamp). */
    sinceStamp = 0,
  ): Promise<
    | { state: 'stopped'; info: StoppedInfo; session: DapSession }
    | { state: 'terminated' }
    | { state: 'timeout' }
    | { state: 'aborted' }
  > {
    for (;;) {
      const stopped = this.treeStopped(sinceStamp)
      if (stopped?.lastStopped) {
        return { state: 'stopped', info: stopped.lastStopped, session: stopped }
      }
      if (this.treeTerminated()) return { state: 'terminated' }
      if (signal?.aborted) return { state: 'aborted' }
      const woke = await new Promise<'event' | 'timeout' | 'aborted'>(resolve => {
        const timer = setTimeout(() => {
          cleanup()
          resolve('timeout')
        }, timeoutMs)
        const wake = (): void => {
          cleanup()
          resolve('event')
        }
        const onAbort = (): void => {
          cleanup()
          resolve('aborted')
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          this.#stateWaiters.delete(wake)
          signal?.removeEventListener('abort', onAbort)
        }
        this.#stateWaiters.add(wake)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      if (woke === 'timeout') return { state: 'timeout' }
      if (woke === 'aborted') return { state: 'aborted' }
      // 'event': loop re-reads the pump state (stopped/terminated) above.
    }
  }

  /** Back-compat shape: StoppedInfo | null (null = terminated OR timeout). */
  async waitForStop(timeoutMs = 10_000): Promise<StoppedInfo | null> {
    const outcome = await this.waitForStopOutcome(timeoutMs)
    return outcome.state === 'stopped' ? outcome.info : null
  }

  /**
   * Bounded post-termination output drain (a load-surfaced
   * race): debugpy relays the debuggee's final stdout as 'output' events on
   * the launcher channel, which RACES the server channel's 'terminated'
   * event — a termination report built immediately can miss the program's
   * actual output. Wait for a short quiet window (no new ring entries for
   * `quietMs`, capped at `maxMs`) so termination truth includes what the
   * program really printed.
   */
  async drainOutput(quietMs = 200, maxMs = 1_000): Promise<void> {
    const start = Date.now()
    let lastLen = this.output.length
    let lastChange = Date.now()
    for (;;) {
      if (Date.now() - start >= maxMs) break
      await new Promise(res => setTimeout(res, 50))
      if (this.output.length !== lastLen) {
        lastLen = this.output.length
        lastChange = Date.now()
      } else if (Date.now() - lastChange >= quietMs) {
        break
      }
    }
    this.flushPartialOutput()
  }

  /** The disconnect body's verdict on the debuggee: a program this session
   *  launched is Mercury's to end; one it attached to is left running — a
   *  development server or an editor inspected for a while must survive the
   *  detach (FN-015 rank 32). The attribute rides only where the adapter
   *  advertises supportTerminateDebuggee: the DAP contract says an adapter
   *  without it ignores the flag, and its own default already ends a
   *  launched program and detaches from an attached one. */
  disconnectArguments(): Record<string, unknown> {
    if (this.capabilities?.supportTerminateDebuggee !== true) return {}
    return { terminateDebuggee: this.startMode !== 'attach' }
  }

  async dispose(): Promise<void> {
    // Children first — a parent disconnect can tear the shared server down
    // from under a child's own goodbye.
    for (const child of [...this.children]) {
      await child.dispose()
    }
    try {
      await this.request('disconnect', this.disconnectArguments(), 2_000)
    } catch {
      /* the kill below is the guarantee */
    }
    // The adapter's debuggee is its GRANDCHILD: a leader-only SIGKILL left
    // the program under debug running — port held, files locked — while the
    // tool reported it terminated (FN-015 rank 20). The one tree-kill owner
    // first (bounded reap, a by-pid second strike for survivors), then the
    // sync sweep for the socket, the pending requests and the waiters.
    const child = this.#child
    if (child !== null && child.exitCode === null) {
      const receipt = await endProcessTree(child, 'SIGKILL')
      if (receipt.survivors.length > 0 && child.pid) {
        await endProcessTreeSurvivors(child.pid, receipt.survivors, 'SIGKILL')
      }
    }
    this.killSync()
  }

  /** Synchronous last-resort reaper (process-exit sweep): kills the whole
   *  session tree — children first — drops pending requests and waiters.
   *  Idempotent. */
  killSync(): void {
    for (const child of [...this.children]) {
      try {
        child.killSync()
      } catch {
        /* best-effort reaper */
      }
    }
    try {
      this.#socket?.destroy()
    } catch {
      /* the child kill is the guarantee */
    }
    if (this.#child && this.#child.exitCode === null) this.#child.kill('SIGKILL')
    this.terminated = true
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(new Error('session disposed'))
    }
    this.#pending.clear()
    this.#wakeStateWaiters()
    this.#stateWaiters.clear()
  }

  /** TEST-ONLY: live waiter count (leak proofs). */
  _stateWaiterCountForTesting(): number {
    return this.#stateWaiters.size
  }
}

//
//  Session registry — OWNER-ADDRESSED since: keys are
//  `${owner}::${alias}`, so two conversations in one process can each use
//  alias 'main' without collision. Disconnect removes; owner disposal (via
//  ownerLifecycle) reaps a conversation's whole fleet on /clear, session
//  switch, or teardown; a process-exit sweep sync-kills any survivors so no
//  adapter child can outlive Mercury. Sessions deliberately SURVIVE ordinary
//  turn boundaries — a debugger is a multi-turn instrument.
//

const sessions = new Map<string, DapSession>()

function registryKey(owner: OwnerKey, id: string): string {
  return `${owner}::${id}`
}

//  (external-projection): sessions mirror into the execution
// plane; liveness truth for reconcile = the adapter child itself.
function dapExecutionSpec(id: string, adapterKey: string) {
  return {
    id: `debug:${id}`,
    kind: 'debug-adapter' as const,
    label: `debug ${id} (${adapterKey})`,
    lifecycle: 'owner' as const,
    metadata: { alias: id, adapterKey },
  }
}

registerExecutionDomain('debug-adapter', {
  reconcile: record => {
    const alias = record.spec.metadata?.alias
    if (typeof alias !== 'string') return null
    const session = sessions.get(registryKey(record.spec.owner, alias))
    if (!session) return { state: 'stopped', outcome: { reason: 'session gone (reconciled)' } }
    return session.alive
      ? { state: record.state }
      : { state: 'stopped', outcome: { reason: 'adapter terminated (reconciled)' } }
  },
  requestStop: record => {
    const alias = record.spec.metadata?.alias
    if (typeof alias !== 'string') return
    void removeDapSession(record.spec.owner, alias).catch(() => {})
  },
})

export function getDapSession(owner: OwnerKey, id: string): DapSession | undefined {
  return sessions.get(registryKey(owner, id))
}

/** List ONE owner's sessions (a conversation never sees another's fleet). */
export function listDapSessions(owner: OwnerKey): Array<{ id: string; session: DapSession }> {
  const prefix = `${owner}::`
  return [...sessions.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, session]) => ({ id: key.slice(prefix.length), session }))
}

/** TEST-ONLY: total live session count across every owner (leak proofs). */
export function _dapSessionCountForTesting(): number {
  return sessions.size
}

/** A free loopback port, OS-assigned. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export async function createDapSession(options: {
  owner: OwnerKey
  id: string
  adapterKey: string
  program: string
  args?: string[]
  /** Runtime (interpreter) flags for split-grammar adapters — see launch. */
  runtimeArgs?: string[]
  cwd: string
  stopOnEntry?: boolean
  breakpoints?: Map<string, Array<number | DapBreakpointSpec>>
  /** 'attach' joins a running debuggee (pid, port, or program). */
  mode?: 'launch' | 'attach'
  pid?: number
  /** attach: the debuggee's DAP/agent socket. */
  port?: number
  host?: string
  /** RUN without debugging (DAP noDebug — the launch-profile run path). */
  noDebug?: boolean
  /** Doctor deep-probe seam: a self-contained spec that bypasses the adapter
   *  table (never reachable from the model-facing tool surface). */
  specOverride?: DapAdapterSpec
}): Promise<DapSession> {
  const resolved = options.specOverride ?? resolveAdapter(options.adapterKey)
  if (!resolved) {
    // Name the dormant builtin lanes beside the known keys: 'unknown
    // adapter js' on a box one unpack away from a js debugger must teach
    // the arm line, not just refuse.
    const dormant = dormantBuiltinAdapterHints()
    throw new Error(
      `unknown adapter '${options.adapterKey}' — known: ${knownAdapterKeys().join(', ')}` +
        (dormant.length > 0
          ? `; dormant builtin lanes (install to arm): ${dormant.map(d => `${d.key} — ${d.hint}`).join(' · ')}`
          : '') +
        ` (extend via MERCURY_DAP_ADAPTERS or <configHome>/dap-adapters.json)`,
    )
  }
  if (resolved.preflightError) {
    // Resolver-established unavailability: refuse honestly BEFORE spawning a
    // doomed child (a broken interpreter hangs the whole launch dance).
    throw new Error(
      `adapter '${options.adapterKey}' is unavailable: ${resolved.preflightError}` +
        (resolved.installHint ? ` — ${resolved.installHint}` : ''),
    )
  }
  // Token substitution: `${port}` (tcp servers) · `${program}` / `${args}`
  // (adapters that host their debuggee). The substituted spec is this
  // session's alone — the table row stays pristine.
  const tcpPort = resolved.connect === 'tcp' ? await pickFreePort() : undefined
  const spec: DapAdapterSpec = {
    ...resolved,
    args: resolved.args.flatMap(arg => {
      if (arg === '${args}') return options.args ?? []
      let out = arg
      if (tcpPort !== undefined) out = out.replaceAll('${port}', String(tcpPort))
      out = out.replaceAll('${program}', options.program)
      return [out]
    }),
  }
  const key = registryKey(options.owner, options.id)
  // A re-launch on the same alias replaces THIS OWNER's session only.
  const existing = sessions.get(key)
  if (existing) {
    await existing.dispose()
    projectExternalState(options.owner, dapExecutionSpec(options.id, options.adapterKey), 'stopped', {
      outcome: { reason: 'replaced by a re-launch on the same alias' },
    })
  }
  const session = new DapSession(options.adapterKey, spec, options.program, options.cwd, tcpPort, 'spawn', {
    parent: null,
    label: options.id,
  })
  sessions.set(key, session)
  projectExternalState(options.owner, dapExecutionSpec(options.id, options.adapterKey), 'starting')
  // Owner-wide teardown: cancel//clear/session-switch/process teardown reaps
  // the whole fleet through the ONE lifecycle registry.
  registerOwnerDisposer(options.owner, `dap:${options.id}`, async () => {
    const live = sessions.get(key)
    if (live) {
      sessions.delete(key)
      await live.dispose()
    }
  })
  try {
    await session.launch({
      program: options.program,
      args: options.args,
      runtimeArgs: options.runtimeArgs,
      stopOnEntry: options.stopOnEntry,
      breakpoints: options.breakpoints,
      mode: options.mode,
      pid: options.pid,
      port: options.port,
      host: options.host,
      noDebug: options.noDebug,
    })
  } catch (err) {
    // The adapter/debuggee output ring is the best failure evidence there is
    // (a dying debuggee prints WHY to stderr; a bare timeout says nothing) —
    // carry its tail on the launch error.
    const outputTail = session.output.slice(-6).join('\n')
    await session.dispose()
    sessions.delete(key)
    unregisterOwnerDisposer(options.owner, `dap:${options.id}`)
    projectExternalState(options.owner, dapExecutionSpec(options.id, options.adapterKey), 'failed', {
      outcome: { reason: `launch failed: ${(err as Error).message.slice(0, 120)}` },
    })
    const hint = spec.installHint ? ` (${spec.installHint})` : ''
    const tail = outputTail ? `\nadapter/debuggee output:\n${outputTail}` : ''
    throw new Error(`${(err as Error).message}${hint}${tail}`)
  }
  projectExternalState(options.owner, dapExecutionSpec(options.id, options.adapterKey), 'running')
  return session
}

export async function removeDapSession(owner: OwnerKey, id: string): Promise<boolean> {
  const key = registryKey(owner, id)
  const session = sessions.get(key)
  if (!session) return false
  sessions.delete(key)
  unregisterOwnerDisposer(owner, `dap:${id}`)
  await session.dispose()
  projectExternalState(owner, dapExecutionSpec(id, session.adapterKey), 'stopped', {
    outcome: { reason: 'session disconnected' },
  })
  return true
}

// Process-exit sweep: exit handlers must be synchronous — sync-kill every
// surviving adapter child so none outlives Mercury.
process.on('exit', () => {
  for (const [, session] of sessions) {
    try {
      session.killSync()
    } catch {
      /* best-effort reaper */
    }
  }
  sessions.clear()
})
