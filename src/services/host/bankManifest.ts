import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBankSums } from './boxBank.js'
import type { HostRecipe, HostWeightManifest } from './recipes.js'
import { hostWeightManifestSchema } from './recipesFile.js'

export interface BankManifest { manifest?: HostWeightManifest; reason?: string }
interface FolderFile { path: string; size: number; mtimeNs: string }
const bookkeeping = new Set(['SHA256SUMS', 'SHA256SUMS.expected', 'SHA256SUMS.verified', 'SIZES.json', 'SAMPLES.json'])
const unsealedHashCap = 256 * 1024 * 1024
const memo = new Map<string, { fingerprint: string; result: BankManifest }>()
const gb = (bytes: number): string => bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB' : bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.ceil(bytes / 1e3) + ' KB'
export const manifestBytes = (manifest: Pick<HostWeightManifest, 'files'>): number => manifest.files.reduce((sum, file) => sum + file.size, 0)
export function bytesMatchRecipe(bytes: number, weightsGb: number): boolean {
  const text = String(weightsGb)
  if (!Number.isFinite(weightsGb) || /e/i.test(text)) return bytes === Math.round(weightsGb * 1e9)
  const decimals = text.includes('.') ? text.length - text.indexOf('.') - 1 : 0
  return Math.abs(bytes - weightsGb * 1e9) <= 0.5 * 10 ** (9 - decimals)
}
function folderFiles(root: string): FolderFile[] {
  const rows: FolderFile[] = []
  const walk = (dir: string, prefix: string): void => {
    let names: string[]
    try { names = readdirSync(dir).sort() } catch { return }
    for (const name of names) {
      if (name === '.DS_Store' || !prefix && (name === '.cache' || bookkeeping.has(name))) continue
      let stat
      try { stat = lstatSync(join(dir, name), { bigint: true }) } catch { continue }
      if (stat.isDirectory()) walk(join(dir, name), prefix + name + '/')
      else if (stat.isFile()) rows.push({ path: prefix + name, size: Number(stat.size), mtimeNs: String(stat.mtimeNs) })
    }
  }
  walk(root, '')
  return rows
}
function receiptRevisions(root: string, paths: string[]): string[] {
  const seen = new Set<string>()
  for (const path of paths) {
    let first: string | undefined
    try { first = readFileSync(join(root, '.cache/huggingface/download', path + '.metadata'), 'utf8').split('\n')[0]?.trim() } catch { continue }
    if (first && /^[a-f0-9]{40}$/.test(first)) seen.add(first)
  }
  if (!seen.size) {
    let trees: string[] = []
    try { trees = readdirSync(join(root, '.cache/huggingface/trees')).filter(name => /^[a-f0-9]{40}\.json$/.test(name)) } catch {}
    for (const name of trees) seen.add(name.slice(0, 40))
  }
  return [...seen].sort()
}
const sourceRevision = (recipe: HostRecipe): string | undefined => /\/(?:tree|commit|resolve|blob)\/([a-f0-9]{40})(?:[/?#]|$)/.exec(recipe.source)?.[1]
function recordedSizes(text: string): Map<string, number> {
  const sizes = new Map<string, number>()
  if (!text) return sizes
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return sizes }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.entries(parsed as Record<string, unknown>) : []
  for (const row of rows) if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'number' && Number.isInteger(row[1]) && row[1] >= 0) sizes.set(row[0], row[1])
  return sizes
}
function gitBlob(file: string, size: number): string | undefined {
  const data = readFileSync(file)
  if (data.length !== size) return
  return createHash('sha1').update('blob ' + size + '\0').update(data).digest('hex')
}
function build(recipe: HostRecipe, path: string, sumsText: string, files: FolderFile[], sizesText: string): BankManifest {
  let sums: Map<string, string>
  try { sums = parseBankSums(sumsText) } catch (error) { return { reason: 'SHA256SUMS in ' + path + ' cannot be read: ' + (error instanceof Error ? error.message : String(error)) } }
  if (!sums.size) return { reason: 'SHA256SUMS in ' + path + ' names no files · b banks the weights and seals one' }
  const present = new Map(files.map(file => [file.path, file]))
  const recorded = recordedSizes(sizesText)
  const rows: HostWeightManifest['files'] = []
  for (const [file, sha256] of sums) {
    const size = present.get(file)?.size ?? recorded.get(file)
    if (size === undefined) return { reason: file + ' is named in SHA256SUMS but is missing from the bank · b resumes the download' }
    rows.push({ path: file, size, sha256 })
  }
  const unsealed = files.filter(file => !sums.has(file.path))
  const total = rows.reduce((sum, file) => sum + file.size, 0) + unsealed.reduce((sum, file) => sum + file.size, 0)
  if (!bytesMatchRecipe(total, recipe.weightsGb)) return { reason: 'the bank holds ' + gb(total) + ' of files but the recipe says ' + recipe.weightsGb + ' GB' }
  for (const file of unsealed) {
    if (file.size > unsealedHashCap) return { reason: 'SHA256SUMS does not name ' + file.path + ' (' + gb(file.size) + ') · b bank again seals it' }
    let git: string | undefined
    try { git = gitBlob(join(path, file.path), file.size) } catch { git = undefined }
    if (!git) return { reason: file.path + ' changed while it was being read · refresh the Bank' }
    rows.push({ path: file.path, size: file.size, git })
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const receipts = receiptRevisions(path, rows.map(file => file.path))
  if (receipts.length > 1) return { reason: 'the bank’s files came from more than one Hugging Face revision (' + receipts.map(hash => hash.slice(0, 7)).join(', ') + ') · b bank again downloads one revision' }
  const revision = receipts[0] ?? sourceRevision(recipe)
  if (!revision) return { reason: 'no Hugging Face revision is recorded for the bank · b bank again records one' }
  const parsed = hostWeightManifestSchema.safeParse({ model: recipe.model, include: recipe.include ?? '', revision, files: rows })
  if (!parsed.success) return { reason: 'the bank has a file name that cannot be mirrored: ' + (rows[Number(parsed.error.issues[0]?.path[1] ?? -1)]?.path ?? parsed.error.issues[0]?.message ?? 'unknown') }
  return { manifest: parsed.data }
}
export function bankManifest(recipe: HostRecipe, path: string): BankManifest {
  let directory = false
  try { directory = lstatSync(path).isDirectory() } catch {}
  if (!directory) return { reason: 'not banked · b banks the weights' }
  let sumsText: string
  try { sumsText = readFileSync(join(path, 'SHA256SUMS'), 'utf8') } catch { return { reason: 'no SHA256SUMS in ' + path + ' · b banks the weights and seals one' } }
  let sizesText = ''
  try { sizesText = readFileSync(join(path, 'SIZES.json'), 'utf8') } catch {}
  const files = folderFiles(path)
  const receipts = receiptRevisions(path, files.map(file => file.path))
  const key = path + '\n' + recipe.model + '\n' + (recipe.include ?? '')
  const fingerprint = createHash('sha256').update(JSON.stringify([sumsText, sizesText, receipts, files, recipe.weightsGb, recipe.source])).digest('hex')
  const cached = memo.get(key)
  if (cached && cached.fingerprint === fingerprint) return cached.result
  const result = build(recipe, path, sumsText, files, sizesText)
  memo.set(key, { fingerprint, result })
  return result
}
