import { fork } from 'node:child_process'
import { existsSync, read } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodePackPlatform, runtimeBinaryFor } from '../../services/privateChannel/vendoredRuntime.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

const QUERY_BOUND_MS = 10 * 60_000

function queryBoundMs(): number {
  const raw = (flagEnv('MERCURY_JSON_QUERY_BOUND_MS') ?? '').trim()
  if (!/^\d+$/.test(raw)) return QUERY_BOUND_MS
  const ms = Number(raw)
  return ms > 0 && ms <= QUERY_BOUND_MS ? ms : QUERY_BOUND_MS
}

interface JsonQueryRun {
  outputPath: string
  originsPath?: string
  outputBytes: number
  outputLines: number
  shown: number
  hasMore: boolean
  array: boolean
  sourceBytes: number
  sourceReadBytes: number
  memoryBytes: number
  diagnostics: string
  status: number
  stopped: boolean
}

function jsonQueryPack(): { pack: string; process: string; runtime: string } {
  const here = dirname(fileURLToPath(import.meta.url))
  const binary = process.platform === 'win32' ? 'node.exe' : 'bin/node'
  const bundled = join(here, 'vendor/json-query')
  if (existsSync(join(bundled, '.vendor-manifest.json'))) return { pack: bundled, process: join(bundled, 'jsonQueryProcess.mjs'), runtime: join(here, 'vendor/node', binary) }
  let at = here
  for (let i = 0; i < 6; i++) {
    const pack = join(at, 'vendor/json-query/extracted')
    if (existsSync(join(pack, '.vendor-manifest.json'))) {
      const platform = nodePackPlatform(process.platform, process.arch)
      const runtime = platform === null ? process.execPath : join(at, 'vendor/node/extracted', platform, runtimeBinaryFor(platform))
      return { pack, process: join(here, 'jsonQueryProcess.mjs'), runtime: existsSync(runtime) ? runtime : process.execPath }
    }
    if (existsSync(join(at, 'package.json')) || existsSync(join(at, '.git'))) break
    const next = resolve(at, '..')
    if (next === at) break
    at = next
  }
  throw new Error('The JSON query engine is missing from this installation.')
}

export async function runJsonQuery(
  request: { fd: number; directory: string; query: string; offset: number; limit: number; raw: boolean; compact: boolean; sourceLines?: boolean },
  signal: AbortSignal,
): Promise<JsonQueryRun> {
  signal.throwIfAborted()
  const { pack, process: script, runtime } = jsonQueryPack()
  const child = fork(script, [], {
    execPath: runtime,
    execArgv: [],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: { HOME: request.directory, USERPROFILE: request.directory, TMPDIR: request.directory, LANG: 'C.UTF-8', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}) },
  })
  const kill = (): void => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  process.once('exit', kill)
  let stopInput = false, sourceReadBytes = 0, diagnostics = ''
  let pumping: Promise<void> | undefined
  let sourceFailure: Error | undefined
  child.stdout?.resume()
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-8192) })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const pump = async (): Promise<void> => {
    let position = 0
    while (!stopInput) {
      const buffer = Buffer.allocUnsafe(65536)
      let got: number
      try {
        got = await new Promise<number>((resolve, reject) => read(request.fd, buffer, 0, buffer.length, position, (error, length) => error ? reject(error) : resolve(length)))
      } catch (error) {
        sourceFailure = error as Error
        kill()
        return
      }
      sourceReadBytes += got
      if (stopInput) return
      if (got === 0) { child.stdin?.end(); return }
      position += got
      const sent = await new Promise<boolean>(resolve => {
        const gone = (): void => resolve(false)
        child.stdin!.once('close', gone)
        child.stdin!.write(buffer.subarray(0, got), error => {
          child.stdin!.removeListener('close', gone)
          resolve(!error)
        })
      })
      if (!sent) return
    }
  }
  let result: JsonQueryRun
  try {
    result = await new Promise<JsonQueryRun>((resolve, reject) => {
      let reply: { result?: JsonQueryRun; error?: string } | undefined
      const aborted = (): void => { kill(); reject(signal.reason ?? new Error('JSON query cancelled.')) }
      signal.addEventListener('abort', aborted, { once: true })
      const bound = queryBoundMs()
      const late = setTimeout(() => { kill(); reject(new Error(`The query did not finish within ${bound / 60_000} minutes and was ended. Narrow the filter, or run jq in Bash with a timeout of its own.`)) }, bound)
      const cleanup = (): void => { clearTimeout(late); signal.removeEventListener('abort', aborted) }
      child.on('message', message => {
        const value = message as { result?: JsonQueryRun; error?: string }
        if (value.result || value.error) reply = value
      })
      child.once('error', error => { cleanup(); reject(error) })
      child.stdin?.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { sourceFailure = error; kill() } })
      child.once('close', code => {
        cleanup()
        if (sourceFailure) reject(sourceFailure)
        else if (code !== 0 || !reply?.result) reject(new Error(reply?.error || diagnostics.trim() || `The JSON query process exited without a result (${code}).`))
        else resolve(reply.result)
      })
      const { fd: _fd, ...options } = request
      child.send({ ...options, pack }, error => { if (error) { kill(); reject(error) } })
      pumping = pump()
      if (signal.aborted) aborted()
    })
  } finally {
    stopInput = true
    child.stdin?.destroy()
    kill()
    await closed
    await pumping
    process.removeListener('exit', kill)
  }
  return { ...result, sourceReadBytes }
}
