import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { execFileNoThrow } from '../../../platform/processes/execFileNoThrow.js'
import { subprocessEnv } from '../../../platform/processes/subprocessEnv.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import { executableSuffixes, isExecutablePath } from '../../../platform/host-os/programs.js'
import { gdbInstallHintWords } from '../../../platform/host-os/words.js'

export const GDB_DAP_MIN_MAJOR = 14

export interface GdbProbe {
  viable: boolean
  version?: string
  reason?: string
}

let gdbProbeCache: { at: number; key: string; result: GdbProbe } | null = null
let gdbProbeRun: Promise<GdbProbe> | null = null
const GDB_PROBE_TTL_MS = 30_000

export function findOnPathLocal(name: string): string | undefined {
  const dirs = (hostEnv().PATH ?? '').split(path.delimiter).filter(Boolean)
  const suffixes = executableSuffixes(['.exe', ''])
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix)
      if (isExecutablePath(candidate)) return candidate
    }
  }
  return undefined
}

export function _resetGdbProbeForTesting(): void {
  gdbProbeCache = null
  gdbProbeRun = null
}

const NATIVE_ADAPTER_KEYS = new Set(['lldb', 'gdb', 'codelldb'])
let darwinDebuggerAuthMemo: string | null | undefined

export function _resetDarwinDebuggerAuthForTesting(): void {
  darwinDebuggerAuthMemo = undefined
}

function devToolsSecurityStatus(): string | null {
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
    darwinDebuggerAuthMemo = `${status.stdout ?? ''}${status.stderr ?? ''}`
  } catch {
    darwinDebuggerAuthMemo = null
  }
  return darwinDebuggerAuthMemo
}

export function darwinDebuggerAuthorisationHint(status: () => string | null = devToolsSecurityStatus): string | null {
  const text = status()
  return text !== null && /disabled/i.test(text)
    ? 'macOS debugger authorisation is off (DevToolsSecurity -status: disabled) — a native debugger blocks in task_for_pid until it is granted, and the grant lasts one boot; enable it durably with: sudo DevToolsSecurity -enable'
    : null
}

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
let lldbDapProbeRun: Promise<LldbDapResolution | null> | null = null

export function _resetLldbDapForTesting(): void {
  lldbDapMemo = undefined
  lldbDapProbeRun = null
}

function lldbDapOnPathLocal(): LldbDapResolution | null {
  const onPath = findOnPathLocal('lldb-dap')
  return onPath ? { path: onPath, source: 'path' } : null
}

function lldbDapOfXcrun(status: number | null, stdout: string): LldbDapResolution | null {
  const found = stdout.trim()
  return status === 0 && found !== '' && existsSync(found) ? { path: found, source: 'xcrun' } : null
}

export function resolveLldbDap(): LldbDapResolution | null {
  if (lldbDapMemo !== undefined) return lldbDapMemo
  const onPath = lldbDapOnPathLocal()
  if (onPath) {
    lldbDapMemo = onPath
    return lldbDapMemo
  }
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync('xcrun', ['-f', 'lldb-dap'], {
        windowsHide: true,
        timeout: 5_000,
        encoding: 'utf8',
        env: { ...subprocessEnv() },
      })
      const found = lldbDapOfXcrun(r.status, r.stdout ?? '')
      if (found) {
        lldbDapMemo = found
        return lldbDapMemo
      }
    } catch (error) {
      passedOver(error)
    }
  }
  lldbDapMemo = null
  return lldbDapMemo
}

export function probeLldbDapAsync(): Promise<LldbDapResolution | null> {
  if (lldbDapMemo !== undefined) return Promise.resolve(lldbDapMemo)
  lldbDapProbeRun ??= (async (): Promise<LldbDapResolution | null> => {
    const onPath = lldbDapOnPathLocal()
    if (onPath) return onPath
    if (process.platform !== 'darwin') return null
    const r = await execFileNoThrow('xcrun', ['-f', 'lldb-dap'], { timeout: 5_000, useCwd: false })
    return lldbDapOfXcrun(r.code, r.stdout)
  })()
    .then(found => {
      if (lldbDapMemo === undefined) lldbDapMemo = found
      return lldbDapMemo
    })
    .finally(() => {
      lldbDapProbeRun = null
    })
  return lldbDapProbeRun
}

export function lldbDapFromMemo(): LldbDapResolution | null {
  if (lldbDapMemo !== undefined) return lldbDapMemo
  const onPath = lldbDapOnPathLocal()
  if (onPath) {
    lldbDapMemo = onPath
    return onPath
  }
  if (process.platform !== 'darwin') {
    lldbDapMemo = null
    return null
  }
  void probeLldbDapAsync().catch(passedOver)
  return null
}

export function lldbDapProbePending(): boolean {
  return lldbDapMemo === undefined && process.platform === 'darwin' && lldbDapOnPathLocal() === null
}

function gdbProbeFresh(key: string): GdbProbe | null {
  return gdbProbeCache && gdbProbeCache.key === key && Date.now() - gdbProbeCache.at < GDB_PROBE_TTL_MS ? gdbProbeCache.result : null
}

function gdbProbeOf(stdout: string, status: number | null, timedOut: boolean): GdbProbe {
  const firstLine = stdout.split('\n')[0] ?? ''
  const m = firstLine.match(/(\d+)\.(\d+)/)
  if (timedOut) {
    return { viable: false, reason: 'gdb --version timed out after 5s — the binary hangs; check the install' }
  }
  if (status !== 0 || !m || m[1] === undefined) {
    return { viable: false, reason: `gdb --version unparseable: ${firstLine.slice(0, 80) || `exit ${status ?? 'null'}`}` }
  }
  if (Number(m[1]) < GDB_DAP_MIN_MAJOR) {
    return {
      viable: false,
      version: m[0],
      reason: `gdb ${m[0]} predates the DAP interpreter — gdb ${GDB_DAP_MIN_MAJOR}+ provides -i=dap`,
    }
  }
  return { viable: true, version: m[0] }
}

export function probeGdbDap(): GdbProbe {
  const key = hostEnv().PATH ?? ''
  const fresh = gdbProbeFresh(key)
  if (fresh !== null) return fresh
  let result: GdbProbe
  const bin = findOnPathLocal('gdb')
  if (!bin) {
    result = { viable: false, reason: 'no gdb on PATH' }
  } else {
    try {
      const r = spawnSync(bin, ['--version'], { windowsHide: true, timeout: 5_000, encoding: 'utf8', env: { ...subprocessEnv() } })
      result = gdbProbeOf(r.stdout ?? '', r.status, (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
    } catch (e) {
      result = { viable: false, reason: `gdb probe failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  gdbProbeCache = { at: Date.now(), key, result }
  return result
}

export function probeGdbDapAsync(): Promise<GdbProbe> {
  const key = hostEnv().PATH ?? ''
  const fresh = gdbProbeFresh(key)
  if (fresh !== null) return Promise.resolve(fresh)
  gdbProbeRun ??= (async (): Promise<GdbProbe> => {
    const bin = findOnPathLocal('gdb')
    if (!bin) return { viable: false, reason: 'no gdb on PATH' }
    const r = await execFileNoThrow(bin, ['--version'], { timeout: 5_000, useCwd: false })
    return gdbProbeOf(r.stdout, r.code, /timed out/i.test(r.error ?? ''))
  })()
    .then(result => {
      gdbProbeCache = { at: Date.now(), key, result }
      return result
    })
    .finally(() => {
      gdbProbeRun = null
    })
  return gdbProbeRun
}

export function gdbProbeFromMemo(): GdbProbe {
  if (findOnPathLocal('gdb') === undefined) return { viable: false, reason: 'no gdb on PATH' }
  const last = gdbProbeCache
  if (last === null || gdbProbeFresh(hostEnv().PATH ?? '') === null) void probeGdbDapAsync().catch(passedOver)
  return last?.result ?? { viable: false, reason: 'gdb --version has not answered yet' }
}

export function gdbProbePending(): boolean {
  return gdbProbeCache === null && findOnPathLocal('gdb') !== undefined
}

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

export function netcoredbgInstallHint(platform: string = process.platform): string {
  return platform === 'darwin'
    ? 'brew install netcoredbg (or the Samsung/netcoredbg releases)'
    : 'download netcoredbg from github.com/Samsung/netcoredbg/releases (the Windows and Linux archives ship the netcoredbg binary) and put it on PATH'
}

export const KOTLIN_DEBUG_ADAPTER_HINT = 'download the kotlin-debug-adapter release (github.com/fwcd/kotlin-debug-adapter/releases) and put its bin directory on PATH'
export const ELIXIR_DEBUG_ADAPTER_BINARIES = ['elixir-ls-debugger', 'debug_adapter.sh'] as const
export const ELIXIR_DEBUG_ADAPTER_HINT = 'brew install elixir-ls (ships elixir-ls-debugger) or unpack the elixir-ls release (debug_adapter.sh) onto PATH'

export function gdbInstallHint(platform: string = process.platform): string {
  return gdbInstallHintWords(platform)
}
