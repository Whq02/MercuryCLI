import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadDesktopAddon } from '../services/desktop/pack.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { ensureToolResultsDir, getToolResultsDir } from './toolResultStorage.js'
import { extractPDFPages, removePDFPages } from './pdf.js'

export type OcrResult = { ok: true; engine: string; languages: string[]; text: string } | { ok: false; message: string }
type NativeOcr = { recognise: (bytes: Buffer, page?: number) => Promise<string>; languages: string[] }
export type OcrEngine = ({ kind: 'native'; name: string } & NativeOcr) | { kind: 'tesseract'; name: 'Tesseract'; languages: string[] } | { kind: 'unavailable'; message: string }
export const OCR_UNAVAILABLE = 'OCR is unavailable. Install Tesseract (macOS: `brew install tesseract`; Debian/Ubuntu: `sudo apt-get install tesseract-ocr`) or use a model with image input.'

export async function resolveOcrEngine(options: { platform?: string; native?: () => NativeOcr | undefined; probe?: () => Promise<boolean>; listLanguages?: () => Promise<string[]> } = {}): Promise<OcrEngine> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin' || platform === 'win32') {
    let native: NativeOcr | undefined
    if (options.native) native = options.native()
    else {
      try {
        const loaded = loadDesktopAddon()
        if (loaded.state === 'ok' && loaded.addon.recogniseText && loaded.addon.ocrLanguages) native = { recognise: loaded.addon.recogniseText.bind(loaded.addon), languages: loaded.addon.ocrLanguages() }
      } catch {}
    }
    if (native && native.languages.length) return { kind: 'native', name: platform === 'darwin' ? 'macOS Vision' : 'Windows OCR', ...native }
  }
  const available = options.probe ? await options.probe() : (await execFileNoThrow('tesseract', ['--version'], { timeout: 5000, useCwd: false })).code === 0
  if (!available) return { kind: 'unavailable', message: OCR_UNAVAILABLE }
  const languages: string[] = options.listLanguages ? await options.listLanguages() : []
  if (!options.listLanguages) {
    const listed = await execFileNoThrow('tesseract', ['--list-langs'], { timeout: 5000, useCwd: false })
    if (listed.code === 0) languages.push(...listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z0-9_/.+-]+$/.test(line) && line !== 'osd'))
  }
  return languages.length ? { kind: 'tesseract', name: 'Tesseract', languages } : { kind: 'unavailable', message: 'OCR is unavailable: Tesseract has no installed recognition languages. Install the traineddata for the languages in the document.' }
}

async function cachedOcr(bytes: Buffer, engine: OcrEngine, page: number | undefined, run: () => Promise<string>): Promise<OcrResult> {
  if (engine.kind === 'unavailable') return { ok: false, message: engine.message }
  const digest = createHash('sha256').update(bytes).update(`${engine.name}:v2:${engine.languages.join('+')}:${page ?? 'image'}`).digest('hex')
  const path = join(getToolResultsDir(), `ocr-${digest}.txt`)
  try { return { ok: true, engine: engine.name, languages: engine.languages, text: await readFile(path, 'utf8') } } catch {}
  try {
    const text = await run()
    await ensureToolResultsDir()
    await writeFile(path, text, { mode: 0o600 })
    return { ok: true, engine: engine.name, languages: engine.languages, text }
  } catch (error) {
    return { ok: false, message: `OCR failed (${engine.name}): ${error instanceof Error ? error.message : String(error)}` }
  }
}
async function tesseract(bytes: Buffer, languages: string[], signal?: AbortSignal): Promise<string> {
  const result = await execFileNoThrow('tesseract', ['stdin', 'stdout', '-l', languages.join('+')], { input: bytes, abortSignal: signal, useCwd: false })
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.error || 'Tesseract failed')
  return result.stdout.trim()
}
export async function recogniseImage(bytes: Buffer, signal?: AbortSignal): Promise<OcrResult> {
  signal?.throwIfAborted()
  const engine = await resolveOcrEngine()
  const result = await cachedOcr(bytes, engine, undefined, () => engine.kind === 'native' ? engine.recognise(bytes) : tesseract(bytes, engine.kind === 'tesseract' ? engine.languages : [], signal))
  signal?.throwIfAborted()
  return result
}
export async function recognisePdfPage(path: string, bytes: Buffer, page: number, signal?: AbortSignal): Promise<OcrResult> {
  signal?.throwIfAborted()
  const engine = await resolveOcrEngine()
  const result = await cachedOcr(bytes, engine, page, async () => {
    if (engine.kind === 'native') return engine.recognise(bytes, page)
    const rendered = await extractPDFPages(path, { firstPage: page, lastPage: page })
    if (!rendered.success) throw new Error(rendered.error.message)
    const dir = rendered.data.file.outputDir
    try {
      const name = (await readdir(dir)).find(name => name.endsWith('.jpg'))
      if (!name) throw new Error('The PDF renderer produced no page images.')
      return await tesseract(await readFile(join(dir, name)), engine.kind === 'tesseract' ? engine.languages : [], signal)
    } finally { await removePDFPages(dir) }
  })
  signal?.throwIfAborted()
  return result
}
export function renderOcr(result: Extract<OcrResult, { ok: true }>): string {
  return `[OCR: ${result.engine}; languages: ${result.languages.join(', ')}]\n${result.text || '[No text recognised.]'}`
}
