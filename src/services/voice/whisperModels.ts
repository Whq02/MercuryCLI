import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import lock from '../../../vendor/whisper-models.lock.json' with { type: 'json' }

export const WHISPER_MODELS_LOCK_PATH = 'vendor/whisper-models.lock.json'
export const WHISPER_MODELS_SEGMENTS = ['models', 'whisper'] as const
export const WHISPER_MODELS_VENDOR_PATH = 'vendor/whisper-models'

export type WhisperModelLanguage = 'en' | 'multilingual'

export interface WhisperModelRow {
  name: string
  file: string
  url: string
  bytes: number
  sha256: string
  language: WhisperModelLanguage
  words: string
}

export interface WhisperModelCatalogue {
  license: string
  licenseNote: string
  source: string
  defaultName: string
  models: readonly WhisperModelRow[]
}

const HEX64 = /^[0-9a-f]{64}$/

export function decodeWhisperModelsLock(raw: unknown): WhisperModelCatalogue {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${WHISPER_MODELS_LOCK_PATH}: not an object`)
  const m = raw as Record<string, unknown>
  if (typeof m.license !== 'string' || typeof m.licenseNote !== 'string' || typeof m.source !== 'string' || typeof m.default !== 'string') {
    throw new Error(`${WHISPER_MODELS_LOCK_PATH}: license, licenseNote, source and default must be strings`)
  }
  if (!Array.isArray(m.models) || m.models.length === 0) throw new Error(`${WHISPER_MODELS_LOCK_PATH}: models must be a non-empty list`)
  const models: WhisperModelRow[] = []
  const seen = new Set<string>()
  for (const entry of m.models as unknown[]) {
    if (typeof entry !== 'object' || entry === null) throw new Error(`${WHISPER_MODELS_LOCK_PATH}: a model row is not an object`)
    const r = entry as Record<string, unknown>
    if (
      typeof r.name !== 'string' ||
      r.name === '' ||
      typeof r.file !== 'string' ||
      !/^ggml-[A-Za-z0-9._-]+\.bin$/.test(r.file) ||
      typeof r.url !== 'string' ||
      !r.url.startsWith('https://') ||
      typeof r.bytes !== 'number' ||
      !Number.isInteger(r.bytes) ||
      r.bytes <= 0 ||
      typeof r.sha256 !== 'string' ||
      !HEX64.test(r.sha256) ||
      (r.language !== 'en' && r.language !== 'multilingual') ||
      typeof r.words !== 'string'
    ) {
      throw new Error(`${WHISPER_MODELS_LOCK_PATH}: the row ${JSON.stringify(r.name ?? r.file ?? '?')} is not whole (name · file · https url · bytes · sha256 · language · words)`)
    }
    if (seen.has(r.name)) throw new Error(`${WHISPER_MODELS_LOCK_PATH}: the name ${r.name} appears twice`)
    seen.add(r.name)
    models.push({ name: r.name, file: r.file, url: r.url, bytes: r.bytes, sha256: r.sha256, language: r.language, words: r.words })
  }
  if (!seen.has(m.default)) throw new Error(`${WHISPER_MODELS_LOCK_PATH}: the default ${m.default} names no row`)
  return { license: m.license, licenseNote: m.licenseNote, source: m.source, defaultName: m.default, models }
}

export const WHISPER_MODEL_CATALOGUE: WhisperModelCatalogue = decodeWhisperModelsLock(lock)
export const WHISPER_MODELS: readonly WhisperModelRow[] = WHISPER_MODEL_CATALOGUE.models
export const WHISPER_DEFAULT_MODEL: string = WHISPER_MODEL_CATALOGUE.defaultName

export function whisperModelByName(name: string): WhisperModelRow | null {
  const wanted = name.trim()
  return WHISPER_MODELS.find(r => r.name === wanted || r.file === wanted) ?? null
}

export function whisperDefaultModel(): WhisperModelRow {
  const row = whisperModelByName(WHISPER_DEFAULT_MODEL)
  if (row === null) throw new Error(`${WHISPER_MODELS_LOCK_PATH}: the default ${WHISPER_DEFAULT_MODEL} names no row`)
  return row
}

export function mbWords(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}

export function whisperModelsDir(home: string = getMercuryHome()): string {
  return join(home, ...WHISPER_MODELS_SEGMENTS)
}

export type WhisperModelPin =
  | { kind: 'catalogue'; row: WhisperModelRow; pinned: boolean }
  | { kind: 'path'; path: string; name: string }
  | { kind: 'broken'; note: string }

export function resolveWhisperModelPin(): WhisperModelPin {
  const raw = (flagEnv('MERCURY_WHISPER_MODEL') ?? '').trim()
  if (raw === '') return { kind: 'catalogue', row: whisperDefaultModel(), pinned: false }
  const row = whisperModelByName(raw)
  if (row !== null) return { kind: 'catalogue', row, pinned: true }
  const looksLikePath = isAbsolute(raw) || raw.includes('/') || raw.includes('\\') || raw.endsWith('.bin')
  if (looksLikePath) {
    const path = resolve(raw)
    if (existsSync(path) && statSync(path).isFile()) {
      const base = path.split(/[\\/]/).pop() ?? path
      return { kind: 'path', path, name: base.replace(/^ggml-/, '').replace(/\.bin$/, '') }
    }
    return { kind: 'broken', note: `MERCURY_WHISPER_MODEL names ${raw}, which is absent — the pin names itself, no silent fallback` }
  }
  return { kind: 'broken', note: `MERCURY_WHISPER_MODEL=${raw} is not a catalogue name (${WHISPER_MODELS.map(r => r.name).join(' · ')}) or the path of a ggml model file — the pin names itself, no silent fallback` }
}

export type WhisperModelCheck =
  | { state: 'present'; path: string; name: string; bytes: number; language: WhisperModelLanguage; pinned: boolean }
  | { state: 'absent'; path: string; row: WhisperModelRow; note: string }
  | { state: 'mismatch'; path: string; note: string }
  | { state: 'broken'; note: string }

export function whisperDownloadDoor(row: WhisperModelRow = whisperDefaultModel(), home: string = getMercuryHome()): string {
  return `on-device transcription needs a one-time ${mbWords(row.bytes)} download — ${row.words} (${WHISPER_MODEL_CATALOGUE.license}) into ${whisperModelsDir(home)} — /speak download starts it; until then the cloud road serves`
}

export function checkWhisperModel(pin: WhisperModelPin = resolveWhisperModelPin(), opts: { home?: string; dir?: string; digest?: boolean } = {}): WhisperModelCheck {
  if (pin.kind === 'broken') return { state: 'broken', note: pin.note }
  if (pin.kind === 'path') {
    let size = 0
    try {
      size = statSync(pin.path).size
    } catch {
      return { state: 'mismatch', path: pin.path, note: `${pin.path} could not be read` }
    }
    if (size === 0) return { state: 'mismatch', path: pin.path, note: `${pin.path} is empty` }
    return { state: 'present', path: pin.path, name: pin.name, bytes: size, language: /\.en\b/.test(pin.name) ? 'en' : 'multilingual', pinned: true }
  }
  const row = pin.row
  const path = join(opts.dir ?? whisperModelsDir(opts.home ?? getMercuryHome()), row.file)
  if (!existsSync(path)) {
    return { state: 'absent', path, row, note: `pack present, model missing — /speak download fetches ${row.file} (${mbWords(row.bytes)})` }
  }
  const size = statSync(path).size
  if (size !== row.bytes) {
    return { state: 'mismatch', path, note: `${row.file} is ${size} bytes on disk, the lock pins ${row.bytes} — /speak download fetches it again` }
  }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (actual !== row.sha256) {
      return { state: 'mismatch', path, note: `${row.file} does not match the lock digest (expected ${row.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — /speak download fetches it again` }
    }
  }
  return { state: 'present', path, name: row.name, bytes: size, language: row.language, pinned: pin.pinned }
}

export const WHISPER_MODEL_DOWNLOAD_DEADLINE_MS = 15 * 60_000

export interface WhisperModelDownload {
  path: string
  bytes: number
  sha256: string
  ms: number
  reused: boolean
}

export async function downloadWhisperModel(
  row: WhisperModelRow,
  dir: string,
  opts: { fetchImpl?: typeof fetch; deadlineMs?: number; onProgress?: (receivedBytes: number, totalBytes: number) => void; force?: boolean } = {},
): Promise<WhisperModelDownload> {
  const started = Date.now()
  const path = join(dir, row.file)
  if (!opts.force && existsSync(path)) {
    const local = readFileSync(path)
    if (local.byteLength === row.bytes && createHash('sha256').update(local).digest('hex') === row.sha256) {
      return { path, bytes: row.bytes, sha256: row.sha256, ms: Date.now() - started, reused: true }
    }
  }
  mkdirSync(dir, { recursive: true })
  const part = `${path}.part`
  rmSync(part, { force: true })
  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), opts.deadlineMs ?? WHISPER_MODEL_DOWNLOAD_DEADLINE_MS)
  deadline.unref?.()
  try {
    let res: Response
    try {
      res = await fetchImpl(row.url, { signal: controller.signal, redirect: 'follow' })
    } catch (error) {
      throw new Error(controller.signal.aborted ? `the download of ${row.file} passed its deadline` : `the download of ${row.file} could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!res.ok || res.body === null) throw new Error(`the download of ${row.file} failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
    const hash = createHash('sha256')
    let received = 0
    const out = createWriteStream(part)
    const done = new Promise<void>((resolveDone, rejectDone) => {
      out.on('error', rejectDone)
      out.on('close', () => resolveDone())
    })
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength
        if (received > row.bytes) throw new Error(`the download of ${row.file} grew past the ${row.bytes} bytes the lock pins — the file changed upstream`)
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', r))
        opts.onProgress?.(received, row.bytes)
      }
    } catch (error) {
      out.destroy()
      throw controller.signal.aborted ? new Error(`the download of ${row.file} passed its deadline at ${received} of ${row.bytes} bytes`) : error
    }
    out.end()
    await done
    const digest = hash.digest('hex')
    if (received !== row.bytes) throw new Error(`the download of ${row.file} ended at ${received} of ${row.bytes} bytes`)
    if (digest !== row.sha256) throw new Error(`the download of ${row.file} does not match the lock digest (expected ${row.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…) — refusing it`)
    rmSync(path, { force: true })
    renameSync(part, path)
    return { path, bytes: received, sha256: digest, ms: Date.now() - started, reused: false }
  } finally {
    clearTimeout(deadline)
    rmSync(part, { force: true })
  }
}
