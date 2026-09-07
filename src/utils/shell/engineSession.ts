import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { createAndSaveSnapshot } from '../bash/ShellSnapshot.js'
import { quote } from '../bash/shellQuote.js'
import { getGlobPreambleCommand } from './globPreamble.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { endProcessTree } from '../processGroup.js'
import { getPlatform } from '../platform.js'
import { SandboxManager } from '../sandbox/sandbox-adapter.js'
import { getSessionEnvironmentScript } from '../sessionEnvironment.js'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { TaskOutput } from '../task/TaskOutput.js'
import { generateTaskId } from '../../Task.js'
import { getFsImplementation } from '../fsOperations.js'
import { resolveBrushPackDir, type BrushPackResolution } from './brushPack.js'
import { nativeCwdFromShellRecord } from '../windowsPaths.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { sandboxTempEnv } from './bashProvider.js'
import type { ExecResult, ShellCommand } from '../ShellCommand.js'

const SOH = String.fromCharCode(1)
const STX = String.fromCharCode(2)
const ETX = String.fromCharCode(3)
const ENGINE_FLAGS = ['--norc', '--noprofile', '--no-config', '--disable-color'] as const

const PARSE_GUARD_TIMEOUT_MS = 5_000

export type ShellEngineResolution =
  | { engine: 'brush'; binaryPath: string; version: string; platform: string; source: 'vendored' | 'workspace' }
  | { engine: 'system'; requested: 'system' | 'brush'; reason: string }

export function resolveShellEngine(setting?: 'system' | 'brush'): ShellEngineResolution {
  const pin = process.env.MERCURY_SHELL_ENGINE
  const requested: 'system' | 'brush' =
    pin === 'brush' ? 'brush' : pin === 'system' ? 'system' : setting === 'brush' ? 'brush' : 'system'
  if (requested !== 'brush') {
    return { engine: 'system', requested, reason: 'the system shell is selected' }
  }
  const pack = resolvedPack()
  if (pack.state !== 'ok') {
    return {
      engine: 'system',
      requested: 'brush',
      reason: `the shell engine is unavailable, so the system shell serves instead — ${pack.note}`,
    }
  }
  return {
    engine: 'brush',
    binaryPath: pack.binaryPath,
    version: pack.manifest.version,
    platform: pack.manifest.platform,
    source: pack.source,
  }
}

export function recordedCwdToNative(reported: string, platform: string = getPlatform()): string | null {
  if (platform !== 'windows') return reported
  const native = nativeCwdFromShellRecord(reported)
  if ('refused' in native) {
    logForDebugging(`engine cwd record refused — the session directory stays put: ${native.refused}`)
    return null
  }
  return native.path
}

let packResolution: BrushPackResolution | null = null
function resolvedPack(): BrushPackResolution {
  packResolution ??= resolveBrushPackDir()
  return packResolution
}

export function resetShellEngineResolution(): void {
  packResolution = null
}


type LiveSession = {
  child: ChildProcess
  nonce: string
  binaryPath: string
  buffer: Buffer
  reader: (() => void) | null
  onExit: ((code: number | null) => void) | null
  exited: boolean
  sandboxed: boolean
  stderrBuf: Buffer
}

let session: LiveSession | null = null
let queue: Promise<unknown> = Promise.resolve()
let pendingResetNote: string | null = null
let snapshotPromise: Promise<string | undefined> | null = null

export function loopScript(): string {
  return [
    'IFS= read -r __brush_nonce',
    '__brush_run() { eval "$__brush_cmd"; }',
    'while IFS= read -r __brush_esc; do',
    '  __brush_probe=$(pwd -P 2>&1) || cd / 2>&1 || :',
    '  __brush_cmd=$(printf %b "$__brush_esc")',
    '  __brush_st=0',
    "  __brush_run <<'__BRUSH_STDIN__' 2>&1 || __brush_st=$?",
    '__BRUSH_STDIN__',
    "  __brush_cwd=$(pwd -P 2>&1) || __brush_cwd=''",
    `  printf '${SOH}%s %d${STX}%s${ETX}' "$__brush_nonce" "$__brush_st" "$__brush_cwd"`,
    'done',
  ].join('\n')
}

function encodeFrame(payload: string): string {
  let out = ''
  for (const byte of Buffer.from(payload, 'utf8')) {
    if (byte === 0x5c) out += '\\\\'
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte)
    else out += `\\x${byte.toString(16).padStart(2, '0')}`
  }
  return out + '\n'
}

function nextEvent(live: LiveSession): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      if (live.reader === onData) live.reader = null
      if (live.onExit === onExit) live.onExit = null
      resolve()
    }
    const onData = (): void => finish()
    const onExit = (): void => finish()
    live.reader = onData
    live.onExit = onExit
  })
}

async function spawnSession(binaryPath: string, sandbox: EngineSandboxPolicy): Promise<LiveSession> {
  registerEngineCleanup()
  const nonce = randomBytes(16).toString('hex')
  const script = loopScript()

  let file = binaryPath
  let args: string[] = [...ENGINE_FLAGS, '-c', script]
  if (sandbox.enabled) {
    const temp = Object.entries(sandboxTempEnv(sandbox.tmpDir))
      .map(([name, value]) => `${name}=${quote([value])}`)
      .join(' ')
    const payload = `export ${temp}; exec ${quote([binaryPath, ...ENGINE_FLAGS, '-c', script])}`
    const wrapped = await SandboxManager.wrapWithSandbox(payload, '/bin/sh')
    file = '/bin/sh'
    args = ['-c', wrapped]
    try {
      mkdirSync(sandbox.tmpDir, { mode: 0o700 })
    } catch (error) {
      logForDebugging(`could not create the sandbox temp directory ${sandbox.tmpDir}: ${errorMessage(error)}`)
    }
  }

  const live: LiveSession = {
    child: spawn(file, args, {
      cwd: cwdThatResolves(),
      env: { ...subprocessEnv(), SHELL: binaryPath, GIT_EDITOR: 'true', MERCURY: '1', ...envOverrides(sandbox) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: getPlatform() !== 'windows',
      windowsHide: true,
    }),
    nonce,
    binaryPath,
    buffer: Buffer.alloc(0),
    reader: null,
    onExit: null,
    exited: false,
    sandboxed: sandbox.enabled,
    stderrBuf: Buffer.alloc(0),
  }

  live.child.stdout?.on('data', (chunk: Buffer) => {
    live.buffer = live.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([live.buffer, chunk])
    live.reader?.()
  })
  live.child.stderr?.on('data', (chunk: Buffer) => {
    live.stderrBuf = live.stderrBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([live.stderrBuf, chunk])
  })
  live.child.stdin?.on('error', error => {
    logForDebugging(`engine stdin closed: ${errorMessage(error)}`)
  })
  live.child.once('exit', code => {
    live.exited = true
    live.onExit?.(code)
  })
  live.child.once('error', () => {
    live.exited = true
    live.onExit?.(1)
  })

  live.child.stdin?.write(nonce + '\n')
  const seeds: string[] = []
  const snapshot = await getSnapshot(binaryPath)
  if (snapshot) seeds.push(`source ${quote([snapshot])} 2>&1 || :`)
  const sessionScript = await getSessionEnvironmentScript()
  if (sessionScript) seeds.push(sessionScript)
  const preamble = getGlobPreambleCommand(binaryPath)
  if (preamble) seeds.push(preamble)
  if (seeds.length > 0) {
    live.stderrBuf = Buffer.alloc(0)
    live.child.stdin?.write(encodeFrame(seeds.join('\n')))
    await drainOneFrame(live)
  }
  if (live.exited) throw new Error('the shell engine ended during its start')

  return live
}

function envOverrides(sandbox: EngineSandboxPolicy): Record<string, string> {
  const overrides: Record<string, string> = sandbox.enabled ? { ...sandboxTempEnv(sandbox.tmpDir) } : {}
  for (const [key, value] of getSessionEnvVars()) overrides[key] = value
  return overrides
}

function getSnapshot(binaryPath: string): Promise<string | undefined> {
  if (snapshotPromise === null) {
    snapshotPromise = createAndSaveSnapshot(binaryPath).catch(() => undefined)
  }
  return snapshotPromise
}

function cwdThatResolves(): string {
  const fs = getFsImplementation()
  const cwd = getCwd()
  try {
    fs.realpathSync(cwd)
    return cwd
  } catch {
    return getOriginalCwd()
  }
}

async function drainOneFrame(live: LiveSession): Promise<void> {
  const marker = Buffer.from(SOH + live.nonce + ' ', 'utf8')
  const etx = ETX.charCodeAt(0)
  for (;;) {
    const start = live.buffer.indexOf(marker)
    if (start !== -1) {
      const end = live.buffer.indexOf(etx, start + marker.length)
      if (end !== -1) {
        live.buffer = live.buffer.subarray(end + 1)
        return
      }
    }
    if (live.exited) return
    await nextEvent(live)
  }
}


export type EngineSandboxPolicy = { enabled: false } | { enabled: true; tmpDir: string }

export type EngineExecOptions = {
  timeout: number
  signal: AbortSignal
  sandbox?: EngineSandboxPolicy
  onCwd?: (cwd: string) => void
  onProgress?: (recentLines: string, allLines: string, lineCount: number, byteCount: number, isIncomplete: boolean) => void
}

export function runEngineCommand(binaryPath: string, command: string, options: EngineExecOptions): ShellCommand {
  const taskId = generateTaskId('local_bash')
  const taskOutput = new TaskOutput(taskId, options.onProgress ?? null, false)

  let resolveResult!: (result: ExecResult) => void
  const result = new Promise<ExecResult>(resolve => {
    resolveResult = resolve
  })
  let status: ShellCommand['status'] = 'running'
  let settled = false

  const settle = (execResult: ExecResult): void => {
    if (settled) return
    settled = true
    if (status === 'running') status = 'completed'
    resolveResult(execResult)
  }

  queue = queue.then(() => execute()).catch(error => {
    logForDebugging(`engine command failed unexpectedly: ${errorMessage(error)}`)
    settle({ stdout: '', stderr: `shell engine error: ${errorMessage(error)}`, code: 1, interrupted: false })
  })

  async function execute(): Promise<void> {
    if (options.signal.aborted) {
      settle({ stdout: '', stderr: 'Command was aborted before execution', code: 145, interrupted: true })
      return
    }
    if (settled) return
    if (session !== null && session.exited) {
      session = null
      pendingResetNote ??=
        'the shell engine session ended between commands and was restarted; variables, functions and shell options set earlier in this session were lost (the working directory is preserved).'
    }
    let inheritedNote = pendingResetNote
    pendingResetNote = null
    const withInherited = (stderr: string, interrupted: boolean): string =>
      inheritedNote !== null && !interrupted ? (stderr ? `${inheritedNote} ${stderr}` : inheritedNote) : stderr

    const parse = await parseCheck(binaryPath, command)
    if (!parse.ok) {
      settle({ stdout: '', stderr: withInherited(parse.message, false), code: 2, interrupted: false })
      return
    }

    const sandbox: EngineSandboxPolicy = options.sandbox ?? { enabled: false }
    if (session !== null && !session.exited && session.sandboxed !== sandbox.enabled) {
      await killSession(session)
      session = null
      const policyNote = `the shell engine session was restarted because this command runs ${sandbox.enabled ? 'inside' : 'outside'} the sandbox and the previous session ran ${sandbox.enabled ? 'outside' : 'inside'} it (the sandbox policy is the call's); variables, functions and shell options set earlier in this session were lost (the working directory is preserved).`
      inheritedNote = inheritedNote === null ? policyNote : `${inheritedNote} ${policyNote}`
    }

    let live: LiveSession
    try {
      live = await ensureSession(binaryPath, sandbox)
    } catch (error) {
      settle({ stdout: '', stderr: withInherited(`shell engine failed to start: ${errorMessage(error)}`, false), code: 1, interrupted: false, preSpawnError: errorMessage(error) })
      return
    }

    const payload = `cd -- ${quote([cwdThatResolves()])} || :\n${command}`

    const marker = Buffer.from(SOH + live.nonce + ' ', 'utf8')
    const etx = ETX.charCodeAt(0)
    let flushed = 0

    const flushUpTo = (limit: number): void => {
      if (limit <= flushed) return
      const slice = live.buffer.subarray(flushed, limit)
      if (slice.length > 0) taskOutput.writeStdout(slice.toString('utf8'))
      flushed = limit
    }

    const frameFromBuffer = (): { code: number; cwd: string } | null => {
      const start = live.buffer.indexOf(marker)
      if (start === -1) {
        const lastSoh = live.buffer.lastIndexOf(SOH.charCodeAt(0))
        const tail = lastSoh === -1 ? null : live.buffer.subarray(lastSoh)
        const couldBeMarker = tail !== null && tail.length < marker.length && marker.subarray(0, tail.length).equals(tail)
        flushUpTo(couldBeMarker ? lastSoh : live.buffer.length)
        return null
      }
      const end = live.buffer.indexOf(etx, start + marker.length)
      if (end === -1) {
        flushUpTo(start)
        return null
      }
      flushUpTo(start)
      const frame = live.buffer.subarray(start + marker.length, end).toString('utf8')
      const sep = frame.indexOf(STX)
      const parsedCode = sep === -1 ? 1 : parseInt(frame.slice(0, sep), 10)
      const cwd = sep === -1 ? getCwd() : frame.slice(sep + 1)
      live.buffer = live.buffer.subarray(end + 1)
      flushed = 0
      return { code: Number.isNaN(parsedCode) ? 1 : parsedCode, cwd }
    }

    await new Promise<void>(resolveExecute => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined

      let finished = false
      const done = async (partial: { stderr: string; code: number; interrupted: boolean }): Promise<void> => {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort) options.signal.removeEventListener('abort', onAbort)
        live.reader = null
        live.onExit = null
        await new Promise<void>(r => setImmediate(r))
        const externalStderr = live.stderrBuf.toString('utf8')
        live.stderrBuf = Buffer.alloc(0)
        if (externalStderr.length > 0) taskOutput.writeStdout(externalStderr)
        await taskOutput.flush().catch(() => {})
        const stdout = await taskOutput.getStdout()
        settle({ stdout, stderr: withInherited(partial.stderr, partial.interrupted), code: partial.code, interrupted: partial.interrupted })
        resolveExecute()
      }

      const tryComplete = (): void => {
        const frame = frameFromBuffer()
        if (frame === null) return
        if (frame.cwd !== '') {
          const native = recordedCwdToNative(frame.cwd)
          if (native !== null) options.onCwd?.(native)
        }
        void done({ stderr: '', code: frame.code, interrupted: false })
      }

      live.reader = () => tryComplete()
      live.onExit = code => {
        flushUpTo(live.buffer.length)
        session = null
        pendingResetNote =
          'the shell session was reset after that command ended it; variables, functions and shell options set earlier in this session were lost (the working directory is preserved).'
        void done({ stderr: '', code: code ?? 1, interrupted: false })
      }

      timer = setTimeout(() => {
        status = 'killed'
        flushUpTo(live.buffer.length)
        void killSession(live)
        session = null
        pendingResetNote =
          'the shell engine session was reset after the command hit its timeout; earlier variables, functions and options were lost (the working directory is preserved).'
        void done({ stderr: `Command timed out after ${Math.round(options.timeout / 1000)}s.`, code: 143, interrupted: false })
      }, options.timeout)

      onAbort = () => {
        status = 'killed'
        flushUpTo(live.buffer.length)
        void killSession(live)
        session = null
        pendingResetNote =
          'the shell engine session was reset after the command was interrupted; earlier variables, functions and options were lost (the working directory is preserved).'
        void done({ stderr: '', code: 137, interrupted: true })
      }
      options.signal.addEventListener('abort', onAbort, { once: true })

      live.stderrBuf = Buffer.alloc(0)
      try {
        live.child.stdin?.write(encodeFrame(payload))
      } catch (error) {
        void done({ stderr: `shell engine write failed: ${errorMessage(error)}`, code: 1, interrupted: false })
        return
      }
      tryComplete()
    })
  }

  const kill = (): void => {
    if (settled) return
    status = 'killed'
    if (session) {
      void killSession(session)
      session = null
      pendingResetNote =
        'the shell engine session was reset after the command was stopped; earlier variables, functions and options were lost (the working directory is preserved).'
    }
    settle({ stdout: '', stderr: '', code: 137, interrupted: true })
  }

  return {
    background: () => false,
    result,
    kill,
    get status() {
      return status
    },
    cleanup: () => {
      taskOutput.clear()
    },
    taskOutput,
  }
}

async function ensureSession(binaryPath: string, sandbox: EngineSandboxPolicy): Promise<LiveSession> {
  if (session !== null && !session.exited) return session
  session = await spawnSession(binaryPath, sandbox)
  return session
}

async function killSession(live: LiveSession): Promise<void> {
  live.reader = null
  live.onExit = null
  try {
    live.child.stdin?.end()
  } catch {
  }
  if (live.child.pid) {
    try {
      await endProcessTree(live.child, 'SIGKILL')
    } catch {
    }
  }
}

function parseCheck(binaryPath: string, command: string): Promise<{ ok: boolean; message: string }> {
  return new Promise(resolve => {
    let settledGuard = false
    const finish = (ok: boolean, message: string): void => {
      if (settledGuard) return
      settledGuard = true
      resolve({ ok, message })
    }
    let child: ChildProcess
    try {
      child = spawn(binaryPath, [...ENGINE_FLAGS, '-n', '-c', command], {
        env: subprocessEnv(),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish(true, errorMessage(error))
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
      }
      finish(true, '')
    }, PARSE_GUARD_TIMEOUT_MS)
    timer.unref?.()
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) finish(true, '')
      else finish(false, stderr.trim() || `shell parse error (exit ${String(code)})`)
    })
    child.once('error', error => {
      clearTimeout(timer)
      finish(true, errorMessage(error))
    })
  })
}

export async function endEngineSession(): Promise<void> {
  const live = session
  session = null
  pendingResetNote = null
  if (live !== null && !live.exited) await killSession(live)
}

let cleanupRegistered = false
function registerEngineCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  registerCleanup(endEngineSession)
}

export function engineChildForTest(): ChildProcess | null {
  return session?.child ?? null
}

export function resetEngineSessionForTest(): void {
  if (session) void killSession(session)
  session = null
  queue = Promise.resolve()
  pendingResetNote = null
  snapshotPromise = null
  packResolution = null
}
