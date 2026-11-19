import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getOriginalCwd, getSessionTrustAccepted } from '../../../bootstrap/state.js'
import { flagEnabled, flagEnv } from '../../../substrate/flagRegistry.js'
import { isPathTrusted } from '../../../utils/config/trust.js'
import { getCwd } from '../../../utils/cwd.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { projectConfigDirs } from '../../../utils/projectConfig.js'
import { isSettingSourceEnabled } from '../../../utils/settings/constants.js'
import { mercuryUnityEnabled } from '../../ide/unityProject.js'
import { bundledPythonInterpreter, debugpyVendorRoot } from '../debugpyResolver.js'
import { UNITY_ADAPTER_ARM_HINT, UNITY_DAP_ADAPTER_KEY } from '../unityAdapter.js'
import { BASH_DEBUG_HINT, builtinAdapters, codelldbInstallHint, PHP_DEBUG_HINT } from './builtins.js'
import {
  ELIXIR_DEBUG_ADAPTER_HINT,
  findOnPathLocal,
  gdbInstallHint,
  gdbProbePending,
  KOTLIN_DEBUG_ADAPTER_HINT,
  lldbDapFromMemo,
  lldbDapInstallHint,
  lldbDapProbePending,
  netcoredbgInstallHint,
  probeGdbDapAsync,
  probeLldbDapAsync,
} from './probes.js'
import type { DapAdapterSpec } from './shared.js'

export function reachableDapAdapterKeys(): string[] {
  const reachable: string[] = []
  try {
    const table = builtinAdapters('memo')
    for (const key of Object.keys(table)) {
      if (key === 'python') {
        if (
          debugpyVendorRoot() !== null &&
          (bundledPythonInterpreter() !== null || findOnPathLocal('python3') !== undefined || findOnPathLocal('python') !== undefined)
        ) {
          reachable.push(key)
        }
      } else if (key === 'lldb') {
        if (lldbDapFromMemo() !== null) reachable.push(key)
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
      }
    }
  } catch {
  }
  return reachable.sort()
}

export function mercuryDapEnabled(): boolean {
  return flagEnabled('MERCURY_DAP')
}

export function isDapToolCatalogEnabled(): boolean {
  return mercuryDapEnabled() && reachableDapAdapterKeys().length > 0
}

export function dapAdapterProbePending(): boolean {
  return lldbDapProbePending() || gdbProbePending()
}

export function settleDapAdapterProbes(): Promise<void> {
  return Promise.all([probeLldbDapAsync(), probeGdbDapAsync()]).then(
    () => undefined,
    () => undefined,
  )
}

export function debugToolWithholding(): { withheld: false } | { withheld: true; why: string; remedy: string } {
  if (!mercuryDapEnabled()) return { withheld: false }
  const reachable = reachableDapAdapterKeys()
  if (reachable.length > 0) return { withheld: false }
  const hints = [
    'python: pip install debugpy beside a python on PATH (or a build carrying the vendored adapter)',
    `lldb: ${lldbDapInstallHint()}`,
    ...dormantBuiltinAdapterHints('memo').map(h => `${h.key}: ${h.hint}`),
  ]
  const waiting = [lldbDapProbePending() ? 'xcrun -f lldb-dap' : null, gdbProbePending() ? 'gdb --version' : null].filter((w): w is string => w !== null)
  return {
    withheld: true,
    why:
      waiting.length > 0
        ? `no debug adapter is reachable on this machine yet — none of debugpy beside a python, lldb-dap on PATH, dlv, js-debug, rdbg, netcoredbg, dart, flutter, codelldb, php-debug, bash-debug-adapter or a configured adapter table, and the toolchain probe (${waiting.join(', ')}) has not answered — the tool joins at the next catalog build if it finds one`
        : 'no debug adapter is reachable on this machine — none of debugpy beside a python, lldb-dap, gdb, dlv, js-debug, rdbg, netcoredbg, dart, flutter, codelldb, php-debug, bash-debug-adapter or a configured adapter table — so no launch could work',
    remedy: `arm one — ${hints.join(' · ')} — then start a new session or /clear for the tool to join`,
  }
}

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
  if (s.envShape === 'object' || s.envShape === 'pairs') out.envShape = s.envShape
  return out
}

function readAdapterFile(filePath: string): Record<string, DapAdapterSpec> {
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

function fileAdapterTable(): Record<string, DapAdapterSpec> {
  const pinned = flagEnv('MERCURY_DAP_ADAPTERS_FILE')
  if (pinned) return readAdapterFile(pinned)
  const user = readAdapterFile(join(getMercuryHome(), 'dap-adapters.json'))
  try {
    const cwd = getCwd()
    const trusted = isPathTrusted(cwd) || (getSessionTrustAccepted() && path.resolve(cwd) === path.resolve(getOriginalCwd()))
    if (!isSettingSourceEnabled('projectSettings') || !trusted) return user
    const projectFile = join(projectConfigDirs(cwd)[0], 'dap-adapters.json')
    const project = readAdapterFile(projectFile)
    if (Object.keys(project).length > 0) logForDebugging(`dap: loaded trusted project adapter file ${projectFile}`)
    return { ...user, ...project }
  } catch {
    return user
  }
}

export function resolveAdapter(key: string): DapAdapterSpec | null {
  const raw = flagEnv('MERCURY_DAP_ADAPTERS')
  if (raw) {
    try {
      const table = JSON.parse(raw) as Record<string, unknown>
      const row = decodeAdapterRow(table?.[key])
      if (row) return row
    } catch {
    }
  }
  const fromFile = fileAdapterTable()[key]
  if (fromFile) return fromFile
  return builtinAdapters()[key]?.() ?? null
}

export function dormantBuiltinAdapterHints(read: 'live' | 'memo' = 'live'): Array<{ key: string; hint: string }> {
  const table = builtinAdapters(read)
  const out: Array<{ key: string; hint: string }> = []
  if (!('js' in table)) {
    out.push({
      key: 'js',
      hint: 'rebuild with the vendored js-debug (bun run scripts/vendor/fetch-js-debug.ts && bun run build.ts), point MERCURY_JS_DEBUG_DAP at dapDebugServer.js, or unpack js-debug-dap to ~/.js-debug',
    })
  }
  if (!('bash' in table)) {
    out.push({ key: 'bash', hint: BASH_DEBUG_HINT })
  }
  if (!('php' in table)) {
    out.push({ key: 'php', hint: PHP_DEBUG_HINT })
  }
  if (!('codelldb' in table)) {
    out.push({ key: 'codelldb', hint: codelldbInstallHint() })
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
  if (!('dart' in table)) {
    out.push({ key: 'dart', hint: 'install the Dart SDK (dart.dev/get-dart) — it ships dart debug_adapter' })
  }
  if (!('flutter' in table)) {
    out.push({ key: 'flutter', hint: 'install the Flutter SDK (docs.flutter.dev/install) — it ships flutter debug-adapter' })
  }
  if (!('kotlin' in table)) {
    out.push({ key: 'kotlin', hint: KOTLIN_DEBUG_ADAPTER_HINT })
  }
  if (!('elixir' in table)) {
    out.push({ key: 'elixir', hint: ELIXIR_DEBUG_ADAPTER_HINT })
  }
  if (!('gdb' in table)) {
    out.push({ key: 'gdb', hint: gdbInstallHint() })
  }
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
    }
  }
  return [...keys].sort()
}

function dapProjectFile(program: string, marker: string): string | null {
  let directory = path.dirname(path.resolve(program))
  try {
    if (statSync(program).isDirectory()) directory = path.resolve(program)
  } catch {}
  for (;;) {
    const candidate = path.join(directory, marker)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

function isFlutterProgram(program: string): boolean {
  const pubspec = dapProjectFile(program, 'pubspec.yaml')
  if (pubspec === null) return false
  try {
    const document = parseYaml(readFileSync(pubspec, 'utf8'))
    return document?.dependencies?.flutter !== undefined || document?.dev_dependencies?.flutter !== undefined
  } catch {
    return false
  }
}

export function adapterKeyForExtension(ext: string, program?: string): string | null {
  const raw = flagEnv('MERCURY_DAP_ADAPTERS')
  if (raw) {
    try {
      const table = JSON.parse(raw) as Record<string, unknown>
      for (const [key, value] of Object.entries(table)) {
        const row = decodeAdapterRow(value)
        if (row?.fileTypes?.includes(ext)) return key
      }
    } catch {
    }
  }
  for (const [key, row] of Object.entries(fileAdapterTable())) {
    if (row.fileTypes?.includes(ext)) return key
  }
  if (ext === '.sh' || ext === '.bash') return 'bash'
  if (ext === '.php') return 'php'
  if (ext === '.dart') return program && isFlutterProgram(program) ? 'flutter' : 'dart'
  if (program && ['', '.exe', '.rs', '.c', '.cc', '.cpp', '.cxx'].includes(ext) && dapProjectFile(program, 'Cargo.toml') && resolveAdapter('codelldb')) return 'codelldb'
  for (const [key, make] of Object.entries(builtinAdapters())) {
    try {
      if (make().fileTypes?.includes(ext)) return key
    } catch {
    }
  }
  return null
}
