import shippedManifests from '../../../assets/host/weights.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { z } from 'zod/v4'
import { publishAtomicSync } from '../../platform/substrate/fileStore.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isProofShapeRun } from '../roads/privacyLevel.js'
import { hostSetupEstimate } from '../../commands/llmhost/words.js'
import { parseBankSums } from './boxBank.js'
import { bankManifest, bytesMatchRecipe, manifestBytes, type BankManifest } from './bankManifest.js'
import type { HostRecipe, HostWeightManifest as WeightManifest } from './recipes.js'
import { hostRecipeSchema, hostWeightManifestSchema } from './recipesFile.js'
import { hostDirectory } from './store.js'
import { fastLoadEstimate, keptVolumes, matchesVolume, vastVolumeBilling, volumeModel, type KeptVolume } from './volumes.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { mountedVolumeRoots, userHomeDir } from '../../platform/host-os/files.js'
import { hostScriptDialect } from '../../platform/host-os/spawn.js'
import { modelBankCandidateWords } from '../../platform/host-os/words.js'

const bankedModelSchema = z.object({
  path: z.string(), bytes: z.number().nonnegative(), verifiedAt: z.string().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  check: z.enum(['manifest', 'download']).optional(), error: z.string().optional(), failedAt: z.string().optional(),
  recipeRow: hostRecipeSchema.optional(),
})
const registrySchema = z.object({ folder: z.string().optional(), models: z.record(z.string(), bankedModelSchema) })
type BankRegistry = z.infer<typeof registrySchema>
type BankedModel = z.infer<typeof bankedModelSchema>
interface BankFile { path: string; size?: number; sha256?: string; git?: string }
export interface BankState { folder?: string; path?: string; banked: boolean; sealed: boolean; pinned: boolean; files: number; missing: number; bytes: number; verifiedAt?: string; check?: 'manifest' | 'download'; error?: string; failedAt?: string }
interface BankReceipt { sha256: string; bytes: number; files: number; check: 'manifest' | 'download'; at: string }
export const BANK_DOOR = 'Bank · your weights'
const registryPath = (): string => join(hostDirectory(), 'bank.json')
const homeDirectory = (): string => userHomeDir()
const isDirectory = (path: string): boolean => {
  try { return statSync(path).isDirectory() } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}
const probeDirectory = (path: string): boolean => {
  try { return statSync(path).isDirectory() } catch (error) {
    passedOver(error)
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') logForDebugging(`[host] bank folder ${path} could not be checked (${error instanceof Error ? error.message : String(error)})`, { level: 'warn' })
    return false
  }
}
const fileSize = (path: string): number | undefined => {
  try { const stat = lstatSync(path); return stat.isFile() ? stat.size : undefined } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export function readBankRegistry(): BankRegistry {
  try { return registrySchema.parse(JSON.parse(readFileSync(registryPath(), 'utf8'))) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { models: {} }; throw error }
}
export function writeBankRegistry(registry: BankRegistry): void { publishAtomicSync(registryPath(), JSON.stringify(registrySchema.parse(registry)) + '\n', { mode: 0o600 }) }
function patchBankedModel(recipe: HostRecipe, entry: BankedModel | undefined): void {
  const registry = readBankRegistry()
  const models = { ...registry.models }
  if (entry) models[volumeModel(recipe)] = { ...entry, recipeRow: recipe }
  else delete models[volumeModel(recipe)]
  writeBankRegistry({ ...registry, models })
}
export function bankedHostRecipes(folder = bankFolder()): HostRecipe[] {
  if (!folder) return []
  return Object.entries(readBankRegistry().models).flatMap(([model, entry]) => {
    const recipe = entry.recipeRow
    return recipe && model === volumeModel(recipe) && dirname(resolve(entry.path)) === resolve(folder) && probeDirectory(entry.path) ? [recipe] : []
  })
}
export function bankCandidates(): string[] {
  const home = homeDirectory()
  const roots = isProofShapeRun() ? [] : mountedVolumeRoots()
  const mounted = (root: string): string[] => { try { return readdirSync(root).sort().map(name => join(root, name, 'mercury-model-bank')) } catch (error) { passedOver(error); return [] } }
  return [join(home, 'mercury-model-bank'), join(home, 'models'), ...roots.flatMap(mounted)]
}
export const bankCandidateWords = (): string => modelBankCandidateWords()
export function bankFolder(): string | undefined {
  const remembered = readBankRegistry().folder
  if (remembered && probeDirectory(remembered)) return remembered
  return bankCandidates().find(probeDirectory)
}
export function rememberBankFolder(path: string): string {
  const named = path.trim()
  const folder = named.startsWith('~/') || named.startsWith('~\\') ? join(homeDirectory(), named.slice(2)) : resolve(named)
  if (!named || !isAbsolute(folder) || /[\0\r\n]/.test(folder)) throw new Error('Give an absolute folder path on this computer.')
  mkdirSync(folder, { recursive: true })
  if (!isDirectory(folder)) throw new Error('That path is not a folder.')
  writeBankRegistry({ ...readBankRegistry(), folder })
  return folder
}
export const shortFolder = (folder: string): string => folder === homeDirectory() || folder.startsWith(homeDirectory() + sep) ? '~' + folder.slice(homeDirectory().length) : folder
export const bankModelFolder = (folder: string, recipe: HostRecipe): string => join(folder, recipe.model.replaceAll('/', '--'))
export function bankModelPath(folder: string, recipe: HostRecipe): string {
  const canonical = bankModelFolder(folder, recipe)
  if (isDirectory(canonical)) return canonical
  const entry = readBankRegistry().models[volumeModel(recipe)]
  if (entry && dirname(resolve(entry.path)) === resolve(folder) && isDirectory(entry.path)) return entry.path
  let children: string[]
  try { children = readdirSync(folder).sort() } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return canonical
    throw error
  }
  const matching = children.map(name => join(folder, name)).filter(path => {
    try {
      if (!lstatSync(path).isDirectory()) return false
      const sums = parseBankSums(readFileSync(join(path, 'SHA256SUMS'), 'utf8'))
      const { files, pinned } = bankFiles(recipe, path)
      if (!files.length || files.some(file => !sums.has(file.path) && !file.git || fileSize(join(path, file.path)) === undefined || file.size !== undefined && fileSize(join(path, file.path)) !== file.size)) return false
      if (pinned && files.some(file => file.sha256)) return files.every(file => !file.sha256 || sums.get(file.path) === file.sha256)
      for (const name of ['manifest.json', 'config.json']) {
        try {
          const manifest = JSON.parse(readFileSync(join(path, name), 'utf8')) as { model?: string; repo_id?: string; _name_or_path?: string }
          if ([manifest.model, manifest.repo_id, manifest._name_or_path].includes(recipe.model)) return true
        } catch (error) { passedOver(error) }
      }
      return Boolean(recipe.weightFile && basename(recipe.weightFile).startsWith(posix.basename(recipe.model) + '-') && sums.has(recipe.weightFile))
    } catch (error) { passedOver(error); return false }
  })
  return matching.length === 1 ? matching[0]! : canonical
}
const manifestsSchema = z.array(z.object({ model: z.string(), include: z.string(), revision: z.string(), files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), git: z.string().regex(/^[a-f0-9]{40}$/).optional() })) }))
function weightManifests(): WeightManifest[] {
  const localPath = flagEnv('MERCURY_HOST_WEIGHTS_FILE')?.trim()
  if (localPath) return manifestsSchema.parse(JSON.parse(readFileSync(resolve(localPath), 'utf8')))
  return shippedManifests
}
const manifestFits = (row: WeightManifest, recipe: HostRecipe): boolean => row.model === recipe.model && row.include === (recipe.include ?? '') && bytesMatchRecipe(manifestBytes(row), recipe.weightsGb)
export const shippedWeightManifest = (recipe: HostRecipe): WeightManifest | undefined => weightManifests().find(row => row.model === recipe.model && row.include === (recipe.include ?? ''))
function keptVolumeManifest(recipe: HostRecipe): WeightManifest | undefined {
  for (const volume of keptVolumes()) {
    if (volume.state === 'gone' || !matchesVolume(volume, recipe)) continue
    const row = hostWeightManifestSchema.safeParse(volume.recipeRow?.weightManifest)
    if (row.success && manifestFits(row.data, recipe)) return row.data
  }
  return undefined
}
const resolvingBank = new Set<string>()
export function bankWeightManifest(recipe: HostRecipe): BankManifest {
  const key = volumeModel(recipe)
  if (resolvingBank.has(key)) return { reason: 'the bank folder is still being read' }
  resolvingBank.add(key)
  try {
    const folder = bankFolder()
    if (!folder) return { reason: 'no bank folder on this computer · b banks the weights' }
    return bankManifest(recipe, bankModelPath(folder, recipe))
  } catch (error) {
    return { reason: 'the bank cannot be read: ' + (error instanceof Error ? error.message : String(error)) }
  } finally { resolvingBank.delete(key) }
}
type WeightManifestSource = 'recipe' | 'shipped' | 'volume' | 'bank'
export function resolvedWeightManifest(recipe: HostRecipe): { manifest: WeightManifest; source: WeightManifestSource } | undefined {
  const embedded = hostWeightManifestSchema.safeParse(recipe.weightManifest)
  if (embedded.success) return manifestFits(embedded.data, recipe) ? { manifest: embedded.data, source: 'recipe' } : undefined
  const shipped = shippedWeightManifest(recipe)
  if (shipped) return manifestFits(shipped, recipe) ? { manifest: shipped, source: 'shipped' } : undefined
  const volume = keptVolumeManifest(recipe)
  if (volume) return { manifest: volume, source: 'volume' }
  const bank = bankWeightManifest(recipe).manifest
  return bank ? { manifest: bank, source: 'bank' } : undefined
}
export function bankFiles(recipe: HostRecipe, path: string): { files: BankFile[]; pinned: boolean; sealedByBank: boolean } {
  const resolved = resolvedWeightManifest(recipe)
  const manifest = resolved?.manifest ?? bankManifest(recipe, path).manifest
  if (manifest) return { files: manifest.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256, git: file.git })), pinned: true, sealedByBank: !resolved || resolved.source === 'bank' }
  if (recipe.weightFile) {
    const parts = /-00001-of-(\d+)\.gguf$/.exec(recipe.weightFile)
    const shards = parts ? Array.from({ length: Number(parts[1]) }, (_, index) => recipe.weightFile!.replace('-00001-of-', '-' + String(index + 1).padStart(5, '0') + '-of-')) : [recipe.weightFile]
    return { files: shards.map(file => ({ path: file })), pinned: false, sealedByBank: false }
  }
  const named = ['config.json', 'model.safetensors.index.json']
  let indexText: string
  try { indexText = readFileSync(join(path, 'model.safetensors.index.json'), 'utf8') } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { files: named.map(file => ({ path: file })), pinned: false, sealedByBank: false }
    throw error
  }
  const index = JSON.parse(indexText) as { weight_map?: Record<string, string> }
  const shards = [...new Set(Object.values(index.weight_map ?? {}))].filter(file => /^[a-zA-Z0-9_.-]+$/.test(file)).sort()
  return { files: [...named, ...shards].map(file => ({ path: file })), pinned: false, sealedByBank: false }
}
export function bankState(recipe: HostRecipe, folder = bankFolder()): BankState {
  if (!folder) return { banked: false, sealed: false, pinned: false, files: 0, missing: 0, bytes: 0 }
  const path = bankModelPath(folder, recipe)
  const { files, pinned } = bankFiles(recipe, path)
  let bytes = 0
  let missing = 0
  for (const file of files) {
    const size = fileSize(join(path, file.path))
    if (size === undefined || file.size !== undefined && size !== file.size) missing++
    else bytes += size
  }
  const sums = fileSize(join(path, 'SHA256SUMS')) === undefined ? undefined : sha256(readFileSync(join(path, 'SHA256SUMS')))
  const banked = files.length > 0 && missing === 0 && sums !== undefined
  const entry = readBankRegistry().models[volumeModel(recipe)]
  const current = entry && entry.path === path && entry.sha256 === sums
  return { folder, path, banked, sealed: sums !== undefined, pinned, files: files.length, missing, bytes, ...(banked && current && entry.verifiedAt ? { verifiedAt: entry.verifiedAt, check: entry.check } : {}), ...(entry?.error ? { error: entry.error, failedAt: entry.failedAt } : {}) }
}
export function bankFree(folder: string): number | undefined {
  try { const stat = statfsSync(folder); return Number(stat.bavail) * Number(stat.bsize) } catch (error) { passedOver(error); return undefined }
}
export const sizeWords = (gb: number): string => gb >= 1000 ? (gb / 1000).toFixed(1) + ' TB' : gb >= 1 ? (gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10) + ' GB' : gb >= 0.001 ? +(gb * 1000).toFixed(1) + ' MB' : +(gb * 1e6).toFixed(1) + ' KB'
export const bytesWords = (bytes: number): string => sizeWords(bytes / 1e9)
async function hashFile(path: string, signal: AbortSignal): Promise<{ sha256: string; git: string; size: number }> {
  signal.throwIfAborted()
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Not a regular file: ' + path)
  const strong = createHash('sha256')
  const git = createHash('sha1').update('blob ' + stat.size + '\0')
  const stream = createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })
  const abort = (): void => { stream.destroy(new Error('Stopped')) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of stream) { strong.update(chunk as Buffer); git.update(chunk as Buffer) }
  } finally { signal.removeEventListener('abort', abort) }
  const after = lstatSync(path)
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('The file changed while it was being hashed: ' + path)
  return { sha256: strong.digest('hex'), git: git.digest('hex'), size: stat.size }
}
function pinnedMismatch(file: BankFile, hashed: { sha256: string; git: string; size: number }): string | undefined {
  if (file.size !== undefined && hashed.size !== file.size) return 'size differs from the pinned manifest'
  if (file.sha256 && hashed.sha256 !== file.sha256) return 'hash differs from the pinned manifest'
  if (file.git && hashed.git !== file.git) return 'content differs from the pinned manifest'
  return undefined
}
function recordReceipt(recipe: HostRecipe, path: string, receipt: BankReceipt): void {
  patchBankedModel(recipe, { path, bytes: receipt.bytes, verifiedAt: receipt.at, sha256: receipt.sha256, check: receipt.check })
}
export function recordBankFailure(recipe: HostRecipe, path: string, error: string): void {
  const previous = readBankRegistry().models[volumeModel(recipe)]
  patchBankedModel(recipe, { path, bytes: previous?.bytes ?? 0, error, failedAt: new Date().toISOString() })
}
export async function verifyBank(recipe: HostRecipe, folder: string, signal: AbortSignal, progress: (text: string) => void = () => {}): Promise<BankReceipt> {
  const path = bankModelPath(folder, recipe)
  const { files, pinned, sealedByBank } = bankFiles(recipe, path)
  if (!files.length) throw new Error('This recipe names no weight files to verify.')
  if (!existsSync(join(path, 'SHA256SUMS'))) throw new Error('No SHA256SUMS in ' + path + ' · b banks the weights and seals one.')
  const sumsText = readFileSync(join(path, 'SHA256SUMS'), 'utf8')
  const sums = parseBankSums(sumsText)
  const uncovered = files.find(file => !sums.has(file.path) && !file.git)
  if (uncovered) throw new Error('SHA256SUMS does not cover every model file: ' + uncovered.path)
  let bytes = 0
  for (const [index, file] of files.entries()) {
    progress('verifying ' + (index + 1) + '/' + files.length + ' · ' + posix.basename(file.path))
    const target = join(path, file.path)
    if (fileSize(target) === undefined) throw new Error('Missing from the bank: ' + file.path)
    const hashed = await hashFile(target, signal)
    const mismatch = pinnedMismatch(file, hashed)
    if (mismatch) throw new Error(file.path + ' · ' + mismatch)
    if (sums.has(file.path) && hashed.sha256 !== sums.get(file.path)) throw new Error(file.path + ' · hash differs from SHA256SUMS')
    bytes += hashed.size
  }
  const receipt: BankReceipt = { sha256: sha256(sumsText), bytes, files: files.length, check: pinned && !sealedByBank ? 'manifest' : 'download', at: new Date().toISOString() }
  recordReceipt(recipe, path, receipt)
  return receipt
}
export async function sealBank(recipe: HostRecipe, folder: string, signal: AbortSignal, progress: (text: string) => void = () => {}): Promise<BankReceipt> {
  const path = bankModelPath(folder, recipe)
  const { files, pinned, sealedByBank } = bankFiles(recipe, path)
  if (!files.length) throw new Error('This recipe names no weight files to seal.')
  const rows = new Map<string, string>()
  let existingSums: string | undefined
  try { existingSums = readFileSync(join(path, 'SHA256SUMS'), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (existingSums !== undefined) {
    try { for (const [file, hash] of parseBankSums(existingSums)) rows.set(file, hash) } catch (error) { passedOver(error); rows.clear() }
  }
  let bytes = 0
  for (const [index, file] of files.entries()) {
    progress('hashing ' + (index + 1) + '/' + files.length + ' · ' + posix.basename(file.path))
    const target = join(path, file.path)
    if (fileSize(target) === undefined) throw new Error('Missing after the download: ' + file.path)
    const hashed = await hashFile(target, signal)
    const mismatch = pinnedMismatch(file, hashed)
    if (mismatch) throw new Error(file.path + ' · ' + mismatch)
    rows.set(file.path, hashed.sha256)
    bytes += hashed.size
  }
  const sumsText = [...rows].map(([file, hash]) => hash + '  ' + file).join('\n') + '\n'
  publishAtomicSync(join(path, 'SHA256SUMS'), sumsText, { mode: 0o644 })
  const receipt: BankReceipt = { sha256: sha256(sumsText), bytes, files: files.length, check: pinned && !sealedByBank ? 'manifest' : 'download', at: new Date().toISOString() }
  recordReceipt(recipe, path, receipt)
  return receipt
}
export function bankDownloadPlan(recipe: HostRecipe): { revision?: string; include: string[] } {
  const manifest = resolvedWeightManifest(recipe)?.manifest
  if (manifest) return { revision: manifest.revision, include: manifest.files.map(file => file.path) }
  if (recipe.include) return { include: [recipe.include] }
  if (recipe.weightFile) return { include: [posix.dirname(recipe.weightFile) === '.' ? '*.gguf' : posix.dirname(recipe.weightFile) + '/*'] }
  return { include: [] }
}
export function bankDownloadScript(recipe: HostRecipe, path: string, windows = hostScriptDialect() === 'powershell'): string {
  const plan = bankDownloadPlan(recipe)
  const home = homeDirectory()
  if (windows) {
    const ps = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
    const venv = join(home, '.local', 'share', 'mercury-host', 'hf')
    const args = [ps(recipe.model), ...(plan.revision ? ['--revision', ps(plan.revision)] : []), ...(plan.include.length ? ['--include', ...plan.include.map(ps)] : []), '--local-dir', ps(path)].join(' ')
    return 'python -m venv ' + ps(venv) + '\n& ' + ps(join(venv, 'Scripts', 'pip.exe')) + ' install --upgrade huggingface_hub\nif ($LASTEXITCODE -ne 0) { throw "pip install failed" }\n& ' + ps(join(venv, 'Scripts', 'hf.exe')) + ' download ' + args + '\nif ($LASTEXITCODE -ne 0) { throw "download failed" }\n'
  }
  const sh = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
  const venv = join(home, '.local/share/mercury-host/hf')
  const args = [sh(recipe.model), ...(plan.revision ? ['--revision', sh(plan.revision)] : []), ...(plan.include.length ? ['--include', ...plan.include.map(sh)] : []), '--local-dir', sh(path)].join(' ')
  return 'python3 -m venv ' + sh(venv) + '\n' + sh(venv + '/bin/pip') + ' install --upgrade huggingface_hub\n' + sh(venv + '/bin/hf') + ' download ' + args + '\n'
}
export function folderBytes(path: string): number {
  let total = 0
  const walk = (dir: string): void => {
    let names: string[]
    try { names = readdirSync(dir) } catch (error) { passedOver(error); return }
    for (const name of names) {
      const file = join(dir, name)
      let stat
      try { stat = lstatSync(file) } catch (error) { passedOver(error); continue }
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile()) total += stat.size
    }
  }
  walk(path)
  return total
}
export const bootMinutes = (recipe: HostRecipe, volume?: KeptVolume): string => /~(\d+) min total/.exec(volume?.state === 'kept' ? fastLoadEstimate(recipe, volume) : hostSetupEstimate(recipe))?.[1] ?? '?'
export const bootsFromVolume = (recipe: HostRecipe, dataCenter?: string): boolean => {
  if (recipe.engine === 'tensorfold') return false
  const volume = keptVolumes().find(row => row.kind !== 'vast' && matchesVolume(row, recipe) && row.state !== 'gone')
  return volume?.state === 'kept' && (volume.kind === 'global' || !dataCenter || volume.dataCenter === dataCenter)
}
function bankedWords(state: BankState): string {
  if (!state.banked) return 'not banked'
  return 'banked on ' + shortFolder(state.folder!) + (state.error ? ' · check failed · v to retry' : '')
}
export const weightsLine = (recipe: HostRecipe, state = bankState(recipe)): string => sizeWords(recipe.weightsGb) + ' · ' + bankedWords(state)
export function bankRowWords(recipe: HostRecipe, state = bankState(recipe)): string {
  const volume = keptVolumes().find(row => row.kind !== 'vast' && matchesVolume(row, recipe) && row.state !== 'gone')
  const vast = keptVolumes().find(row => row.kind === 'vast' && matchesVolume(row, recipe) && row.state === 'kept')
  const local = state.banked ? bankedWords(state) : 'b to bank · ' + sizeWords(recipe.weightsGb)
  const disks = [volume ? volume.id + ' · ' + volume.state : '', vast ? 'Vast.ai machine ' + vast.machineId + ' · ' + vastVolumeBilling(vast) : ''].filter(Boolean)
  return ['Bank', local, ...disks].join(' · ')
}
