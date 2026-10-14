import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getMercuryHome } from '../utils/envUtils.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import lock from '../../vendor/embed-models.lock.json' with { type: 'json' }
import { loadEmbedAddon } from './embedPack.js'

export const EMBED_MODELS_LOCK_PATH = 'vendor/embed-models.lock.json'
export const EMBED_MODELS_SEGMENTS = ['models', 'embed'] as const
export const EMBED_MODELS_VENDOR_PATH = 'vendor/embed-models'
export const WORD_MATCH_ONLY_WORDS = 'word match only'

export interface EmbedModelRow {
  name: string
  file: string
  url: string
  bytes: number
  sha256: string
  license: string
  dimension: number
  words: string
}

export interface EmbedModelCatalogue {
  license: string
  licenseNote: string
  source: string
  defaultName: string
  models: readonly EmbedModelRow[]
}

const HEX64 = /^[0-9a-f]{64}$/

export function decodeEmbedModelsLock(raw: unknown): EmbedModelCatalogue {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${EMBED_MODELS_LOCK_PATH}: not an object`)
  const m = raw as Record<string, unknown>
  if (typeof m.license !== 'string' || typeof m.licenseNote !== 'string' || typeof m.source !== 'string' || typeof m.default !== 'string') {
    throw new Error(`${EMBED_MODELS_LOCK_PATH}: license, licenseNote, source and default must be strings`)
  }
  if (!Array.isArray(m.models) || m.models.length === 0) throw new Error(`${EMBED_MODELS_LOCK_PATH}: models must be a non-empty list`)
  const models: EmbedModelRow[] = []
  const seen = new Set<string>()
  for (const entry of m.models as unknown[]) {
    if (typeof entry !== 'object' || entry === null) throw new Error(`${EMBED_MODELS_LOCK_PATH}: a model row is not an object`)
    const r = entry as Record<string, unknown>
    if (
      typeof r.name !== 'string' ||
      r.name === '' ||
      typeof r.file !== 'string' ||
      !/^[A-Za-z0-9._-]+\.gguf$/.test(r.file) ||
      typeof r.url !== 'string' ||
      !r.url.startsWith('https://') ||
      typeof r.bytes !== 'number' ||
      !Number.isInteger(r.bytes) ||
      r.bytes <= 0 ||
      typeof r.sha256 !== 'string' ||
      !HEX64.test(r.sha256) ||
      typeof r.license !== 'string' ||
      (r.license !== 'MIT' && r.license !== 'Apache-2.0') ||
      typeof r.dimension !== 'number' ||
      !Number.isInteger(r.dimension) ||
      r.dimension <= 0 ||
      typeof r.words !== 'string'
    ) {
      throw new Error(`${EMBED_MODELS_LOCK_PATH}: the row ${JSON.stringify(r.name ?? r.file ?? '?')} is not whole (name · file · https url · bytes · sha256 · permissive license · dimension · words)`)
    }
    if (seen.has(r.name)) throw new Error(`${EMBED_MODELS_LOCK_PATH}: the name ${r.name} appears twice`)
    seen.add(r.name)
    models.push({
      name: r.name,
      file: r.file,
      url: r.url,
      bytes: r.bytes,
      sha256: r.sha256,
      license: r.license,
      dimension: r.dimension,
      words: r.words,
    })
  }
  if (!seen.has(m.default)) throw new Error(`${EMBED_MODELS_LOCK_PATH}: the default ${m.default} names no row`)
  return { license: m.license, licenseNote: m.licenseNote, source: m.source, defaultName: m.default, models }
}

export const EMBED_MODEL_CATALOGUE: EmbedModelCatalogue = decodeEmbedModelsLock(lock)
export const EMBED_MODELS: readonly EmbedModelRow[] = EMBED_MODEL_CATALOGUE.models
export const EMBED_DEFAULT_MODEL: string = EMBED_MODEL_CATALOGUE.defaultName

export function embedModelByName(name: string): EmbedModelRow | null {
  const wanted = name.trim()
  return EMBED_MODELS.find(r => r.name === wanted || r.file === wanted) ?? null
}

export function embedDefaultModel(): EmbedModelRow {
  const row = embedModelByName(EMBED_DEFAULT_MODEL)
  if (row === null) throw new Error(`${EMBED_MODELS_LOCK_PATH}: the default ${EMBED_DEFAULT_MODEL} names no row`)
  return row
}

export function mbWords(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}

export function embedModelsDir(home: string = getMercuryHome()): string {
  return join(home, ...EMBED_MODELS_SEGMENTS)
}

export type EmbedModelPin =
  | { kind: 'catalogue'; row: EmbedModelRow; pinned: boolean }
  | { kind: 'path'; path: string; name: string }
  | { kind: 'ollama'; model: string }
  | { kind: 'broken'; note: string }

let seededModelSpec: string | null = null
let seededVendorDir: string | null = null

export function seedEmbedModelForTest(spec: string | null, vendorDir: string | null = null): void {
  seededModelSpec = spec
  seededVendorDir = vendorDir
}

function configuredModelSpec(): string {
  if (seededModelSpec !== null) return seededModelSpec.trim()
  const raw = getInitialSettings().memory?.embeddingModel
  return (typeof raw === 'string' ? raw : '').trim()
}

export function resolveEmbedModelPin(specOverride?: string): EmbedModelPin {
  const raw = (specOverride ?? configuredModelSpec()).trim()
  if (raw === '' || raw === 'default') return { kind: 'catalogue', row: embedDefaultModel(), pinned: false }
  if (raw.startsWith('ollama:')) {
    const model = raw.slice('ollama:'.length).trim()
    if (model !== '') return { kind: 'ollama', model }
    return { kind: 'broken', note: 'ollama: embedding model name is empty' }
  }
  const row = embedModelByName(raw)
  if (row !== null) return { kind: 'catalogue', row, pinned: true }
  const looksLikePath = isAbsolute(raw) || raw.includes('/') || raw.includes('\\') || raw.endsWith('.gguf')
  if (looksLikePath) {
    const path = resolve(raw)
    if (existsSync(path) && statSync(path).isFile()) {
      const base = path.split(/[\\/]/).pop() ?? path
      return { kind: 'path', path, name: base.replace(/\.gguf$/i, '') }
    }
    return { kind: 'broken', note: `embedding model path ${raw} is absent — the pin names itself, no silent fallback` }
  }
  return {
    kind: 'broken',
    note: `embedding model ${raw} is not a catalogue name (${EMBED_MODELS.map(r => r.name).join(' · ')}), an ollama:<model> spec, or the path of a gguf model file — the pin names itself, no silent fallback`,
  }
}

function findVendoredModelFile(file: string): string | null {
  if (seededVendorDir !== null) {
    const candidate = join(seededVendorDir, file)
    return existsSync(candidate) ? candidate : null
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  let dir = moduleDir
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'vendor', 'embed-models', file)
    if (existsSync(candidate)) return candidate
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export type EmbedModelCheck =
  | { state: 'present'; path: string; name: string; bytes: number; dimension: number; license: string; pinned: boolean }
  | { state: 'ollama'; model: string }
  | { state: 'absent'; path: string; row: EmbedModelRow; note: string }
  | { state: 'mismatch'; path: string; note: string }
  | { state: 'broken'; note: string }

export function checkEmbedModel(
  pin: EmbedModelPin = resolveEmbedModelPin(),
  opts: { home?: string; dir?: string; digest?: boolean; homeOnly?: boolean } = {},
): EmbedModelCheck {
  if (pin.kind === 'broken') return { state: 'broken', note: pin.note }
  if (pin.kind === 'ollama') return { state: 'ollama', model: pin.model }
  if (pin.kind === 'path') {
    let size = 0
    try {
      size = statSync(pin.path).size
    } catch {
      return { state: 'mismatch', path: pin.path, note: `${pin.path} could not be read` }
    }
    if (size === 0) return { state: 'mismatch', path: pin.path, note: `${pin.path} is empty` }
    return { state: 'present', path: pin.path, name: pin.name, bytes: size, dimension: 768, license: 'custom', pinned: true }
  }
  const row = pin.row
  const primaryDir = opts.dir ?? embedModelsDir(opts.home ?? getMercuryHome())
  const primaryPath = join(primaryDir, row.file)
  const vendoredPath = !opts.dir && !opts.homeOnly ? findVendoredModelFile(row.file) : null
  const path = existsSync(primaryPath) ? primaryPath : (vendoredPath ?? primaryPath)
  if (!existsSync(path)) {
    return { state: 'absent', path: primaryPath, row, note: `pack present, model missing (${row.file}, ${mbWords(row.bytes)}) — ${WORD_MATCH_ONLY_WORDS}` }
  }
  const size = statSync(path).size
  if (size !== row.bytes) {
    return { state: 'mismatch', path, note: `${row.file} is ${size} bytes on disk, the lock pins ${row.bytes}` }
  }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (actual !== row.sha256) {
      return { state: 'mismatch', path, note: `${row.file} does not match the lock digest (expected ${row.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` }
    }
  }
  return { state: 'present', path, name: row.name, bytes: size, dimension: row.dimension, license: row.license, pinned: pin.pinned }
}

export type SemanticReadiness =
  | { state: 'ok'; road: 'local'; model: string; path: string; dimension: number }
  | { state: 'ok'; road: 'ollama'; model: string }
  | { state: 'word-only'; words: typeof WORD_MATCH_ONLY_WORDS; note: string }

export function describeSemanticReadiness(opts: { home?: string; homeOnly?: boolean } = {}): SemanticReadiness {
  const pin = resolveEmbedModelPin()
  if (pin.kind === 'ollama') {
    return { state: 'ok', road: 'ollama', model: pin.model }
  }
  const addon = loadEmbedAddon()
  if (addon.state === 'unavailable') {
    return { state: 'word-only', words: WORD_MATCH_ONLY_WORDS, note: addon.note }
  }
  const modelCheck = checkEmbedModel(pin, opts)
  if (modelCheck.state === 'present') {
    return { state: 'ok', road: 'local', model: modelCheck.name, path: modelCheck.path, dimension: modelCheck.dimension }
  }
  if (modelCheck.state === 'ollama') {
    return { state: 'ok', road: 'ollama', model: modelCheck.model }
  }
  return { state: 'word-only', words: WORD_MATCH_ONLY_WORDS, note: modelCheck.note }
}

export function memoryRecallModeWords(opts: { home?: string; homeOnly?: boolean } = {}): string {
  const ready = describeSemanticReadiness(opts)
  if (ready.state === 'word-only') return WORD_MATCH_ONLY_WORDS
  return ready.road === 'ollama' ? `semantic + word match (ollama:${ready.model})` : `semantic + word match (${ready.model})`
}

export async function probeOllamaEmbeddingModels(
  baseUrl = 'http://127.0.0.1:11434',
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  timer.unref?.()
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: controller.signal })
    if (!res.ok) return []
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> }
    if (!Array.isArray(body.models)) return []
    const names = body.models
      .map(m => (typeof m.name === 'string' ? m.name.trim() : ''))
      .filter(name => name !== '' && /embed|bge|gte|minilm|nomic|e5|arctic/i.test(name))
    return [...new Set(names)]
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export const EMBED_MODEL_DOWNLOAD_DEADLINE_MS = 15 * 60_000

export interface EmbedModelDownload {
  path: string
  bytes: number
  sha256: string
  ms: number
  reused: boolean
}

export async function downloadEmbedModel(
  row: EmbedModelRow,
  dir: string,
  opts: { fetchImpl?: typeof fetch; deadlineMs?: number; onProgress?: (receivedBytes: number, totalBytes: number) => void; force?: boolean } = {},
): Promise<EmbedModelDownload> {
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
  const deadline = setTimeout(() => controller.abort(), opts.deadlineMs ?? EMBED_MODEL_DOWNLOAD_DEADLINE_MS)
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
