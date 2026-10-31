import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { extractTarGz } from './tarExtract.ts'

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
function files(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    if (e.isDirectory()) Object.assign(out, files(path, base))
    else if (e.isFile() && e.name !== '.vendor-manifest.json') out[relative(base, path).replaceAll('\\', '/')] = hash(readFileSync(path))
  }
  return out
}
export function checkPdfjs(root: string): void {
  const lock = JSON.parse(readFileSync(join(root, 'vendor/pdfjs.lock.json'), 'utf8'))
  const dir = join(root, 'vendor/pdfjs/extracted')
  const manifest = JSON.parse(readFileSync(join(dir, '.vendor-manifest.json'), 'utf8'))
  const live = files(dir)
  const recorded: Record<string, string> = manifest.files ?? {}
  const added = Object.keys(live).filter(f => !(f in recorded))
  const missing = Object.keys(recorded).filter(f => !(f in live))
  const changed = Object.keys(live).filter(f => f in recorded && recorded[f] !== live[f])
  const ordered = JSON.stringify(live) !== JSON.stringify(recorded) && added.length === 0 && missing.length === 0 && changed.length === 0
  if (manifest.version !== lock.version || manifest.sha256 !== lock.sha256 || added.length > 0 || missing.length > 0 || changed.length > 0 || ordered) {
    const detail = [
      manifest.version !== lock.version ? `version ${manifest.version} vs lock ${lock.version}` : '',
      manifest.sha256 !== lock.sha256 ? 'archive sha256 differs' : '',
      added.length ? `added: ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` (+${added.length - 5})` : ''}` : '',
      missing.length ? `missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''}` : '',
      changed.length ? `changed: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` (+${changed.length - 5})` : ''}` : '',
      ordered ? 'same files, listed in another order' : '',
    ].filter(Boolean).join('; ')
    throw new Error(`PDF.js vendor cache differs from its lock (${detail}); run bun scripts/vendor/fetch-pdfjs.ts`)
  }
}
export async function fetchPdfjs(root: string, archive?: string): Promise<void> {
  const lock = JSON.parse(readFileSync(join(root, 'vendor/pdfjs.lock.json'), 'utf8'))
  const cache = join(root, 'vendor/pdfjs')
  const dest = join(cache, 'extracted')
  mkdirSync(cache, { recursive: true })
  const tarball = join(cache, 'pdfjs.tgz')
  let bytes: Buffer
  if (archive) bytes = readFileSync(archive)
  else if (existsSync(tarball) && hash(readFileSync(tarball)) === lock.sha256) bytes = readFileSync(tarball)
  else {
    const response = await fetch(lock.url)
    if (!response.ok) throw new Error(`PDF.js download: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (hash(bytes) !== lock.sha256 || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== lock.integrity) throw new Error('PDF.js tarball digest does not match its lock')
  writeFileSync(tarball, bytes)
  const stage = join(cache, 'stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage)
  try {
    const result = extractTarGz({ tarballPath: tarball, destDir: stage, stripComponents: 1 })
    if (!result.ok) throw new Error(result.message)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest)
    for (const name of lock.files as string[]) {
      mkdirSync(join(dest, name, '..'), { recursive: true })
      cpSync(join(stage, name), join(dest, name), { recursive: true })
    }
    writeFileSync(join(dest, '.vendor-manifest.json'), JSON.stringify({ version: lock.version, sha256: lock.sha256, files: files(dest) }))
    checkPdfjs(root)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
export function vendorPdfjs(root: string, out: string): void {
  checkPdfjs(root)
  const dest = join(out, 'vendor/pdfjs')
  rmSync(dest, { recursive: true, force: true })
  cpSync(join(root, 'vendor/pdfjs/extracted'), dest, { recursive: true })
  cpSync(join(root, 'src/utils/pdfTextWorker.mjs'), join(dest, 'pdfTextWorker.mjs'))
}
