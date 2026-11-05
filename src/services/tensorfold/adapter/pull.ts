import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { Readable } from 'node:stream'
import { ggufOnDisk, ggufPaths, hubEndpoint, type GgufSource } from '../hfCache.js'
import { ADAPTER_VERSION } from './identity.js'

type GgufPullIo = {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onBytes?: (bytes: number) => void
}

type GgufPullOutcome = { path: string; bytes: number; downloaded: boolean }

export class GgufPullError extends Error {
  constructor(message: string, public readonly stopped = false) {
    super(message)
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function placeSnapshot(blob: string, snapshotFile: string): void {
  mkdirSync(dirname(snapshotFile), { recursive: true })
  if (existsSync(snapshotFile)) {
    if (statSync(snapshotFile).size === statSync(blob).size) return
    rmSync(snapshotFile, { force: true })
  }
  try {
    linkSync(blob, snapshotFile)
    return
  } catch {
    void 0
  }
  try {
    symlinkSync(relative(dirname(snapshotFile), blob), snapshotFile)
    return
  } catch {
    void 0
  }
  copyFileSync(blob, snapshotFile)
}

function ggufDownloadUrl(gguf: GgufSource, env: NodeJS.ProcessEnv = process.env): string {
  return `${hubEndpoint(env)}/${gguf.repo}/resolve/${gguf.revision}/${encodeURI(gguf.file)}`
}

export async function pullGguf(root: string, gguf: GgufSource, io: GgufPullIo = {}): Promise<GgufPullOutcome> {
  const env = io.env ?? process.env
  const fetchImpl = io.fetchImpl ?? fetch
  const paths = ggufPaths(root, gguf)
  mkdirSync(dirname(paths.blob), { recursive: true })
  mkdirSync(paths.snapshotDir, { recursive: true })
  const settle = (downloaded: boolean): GgufPullOutcome => {
    placeSnapshot(paths.blob, paths.snapshotFile)
    return { path: paths.snapshotFile, bytes: gguf.bytes, downloaded }
  }
  if (ggufOnDisk(root, gguf).complete) return settle(false)
  let have = sizeOf(paths.incomplete)
  if (have > gguf.bytes) {
    rmSync(paths.incomplete, { force: true })
    have = 0
  }
  if (have < gguf.bytes) {
    const headers: Record<string, string> = { 'user-agent': `mercury-tensorfold-adapter/${ADAPTER_VERSION}`, ...(have > 0 ? { range: `bytes=${have}-` } : {}), ...(env.HF_TOKEN ? { authorization: `Bearer ${env.HF_TOKEN}` } : {}) }
    let response: Response
    try {
      response = await fetchImpl(ggufDownloadUrl(gguf, env), { headers, ...(io.signal !== undefined ? { signal: io.signal } : {}) })
    } catch (error) {
      if (io.signal?.aborted) throw new GgufPullError('the download stopped; it resumes next time', true)
      throw new GgufPullError(`Hugging Face did not answer: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 401 || response.status === 403) throw new GgufPullError(`${gguf.repo} is gated or needs a token; Hugging Face answered ${response.status}`)
    if (response.status === 200 && have > 0) {
      rmSync(paths.incomplete, { force: true })
      have = 0
    } else if (response.status !== 200 && response.status !== 206) {
      throw new GgufPullError(`Hugging Face answered ${response.status} for ${gguf.repo}/${gguf.file}`)
    }
    if (response.body === null) throw new GgufPullError('Hugging Face sent no body')
    const out = createWriteStream(paths.incomplete, { flags: have > 0 ? 'a' : 'w' })
    try {
      for await (const chunk of Readable.fromWeb(response.body as never)) {
        const bytes = chunk as Buffer
        if (!out.write(bytes)) await new Promise<void>(resolve => out.once('drain', resolve))
        have += bytes.length
        io.onBytes?.(have)
        if (io.signal?.aborted) break
      }
    } catch (error) {
      if (!io.signal?.aborted) throw new GgufPullError(`the download broke off at ${have} of ${gguf.bytes} bytes: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await new Promise<void>(resolve => out.end(resolve))
    }
    if (io.signal?.aborted) throw new GgufPullError('the download stopped; it resumes next time', true)
    if (have !== gguf.bytes) throw new GgufPullError(`the download ended at ${have} of ${gguf.bytes} bytes`)
  }
  const digest = await sha256OfFile(paths.incomplete)
  if (digest !== gguf.sha256) {
    rmSync(paths.incomplete, { force: true })
    throw new GgufPullError(`${gguf.file} did not match its pinned sha256 (${digest.slice(0, 12)}… instead of ${gguf.sha256.slice(0, 12)}…); the download was discarded`)
  }
  renameSync(paths.incomplete, paths.blob)
  return settle(true)
}
