import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { bankModelPath, bytesWords } from '../host/bank.js'
import { fetchHuggingFaceRepo, ggufQuantGroups, type HfFile, type HfHubOptions } from '../host/hfRecipes.js'
import { hubFileUrl, parseGgufHeader, readGgufHeader } from '../host/ggufHeader.js'
import { HOST_RECIPES, type HostRecipe } from '../host/recipes.js'
import { hostRecipeSchema, hostWeightManifestSchema } from '../host/recipesFile.js'
import { fitLocalWindow, type LocalWindowFit } from '../localServer/localWindowFit.js'
import { gibWords, kvGeometryOf, tokensWords } from '../localServer/localServerMemory.js'
import { defaultMachineTruth } from '../localServer/localServerTruth.js'

type GgufHeader = Extract<ReturnType<typeof parseGgufHeader>, { state: 'ok' }>['header']
export interface GgufModel { recipe: HostRecipe; header?: GgufHeader; fit?: LocalWindowFit; words: string; error?: string }
export const ggufModelName = (recipe: HostRecipe): string => basename(recipe.weightFile!).replace(/-00001-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '')
function ggufFit(recipe: HostRecipe, header: GgufHeader, machineBytes: number, platform: NodeJS.Platform): LocalWindowFit | undefined {
  const geometry = kvGeometryOf(header.kv)
  const nextn = Number(header.kv[header.architecture + '.nextn_predict_layers'] ?? 0)
  const perLayer = header.kv[header.architecture + '.attention.head_count_kv']
  if (geometry?.interval && geometry.interval > 1 && nextn > 0 && typeof perLayer === 'number') {
    geometry.attentionLayers = Math.floor((geometry.blockCount - nextn) / geometry.interval) + nextn
    geometry.kvHeads = geometry.attentionLayers * perLayer
  }
  const trainedMax = Number(header.kv[header.architecture + '.context_length'])
  if (!geometry || !Number.isSafeInteger(trainedMax) || trainedMax <= 0) return undefined
  return fitLocalWindow({ name: ggufModelName(recipe), weightsBytes: recipe.weightsGb * 1e9, geometry, trainedMax, machineBytes, usableBytes: defaultMachineTruth(platform, machineBytes).usableMemoryBytes, cacheType: 'f16', slots: 1 })
}
export function ggufModelRow(recipe: HostRecipe, header: GgufHeader | undefined, machineBytes: number, platform: NodeJS.Platform, error?: string): GgufModel {
  const fit = header && ggufFit(recipe, header, machineBytes, platform)
  const memory = fit ? gibWords(fit.totalBytes) + ' memory · ' + (fit.fits ? 'fits · ' + tokensWords(fit.window) : 'does not fit') : 'select to inspect memory'
  return { recipe, header, fit, words: bytesWords(recipe.weightsGb * 1e9) + ' · ' + memory, error: error ?? (!fit ? 'The GGUF header does not state the context and cache geometry needed to size this model.' : undefined) }
}
async function localGgufHeader(path: string, signal?: AbortSignal): Promise<GgufHeader> {
  const file = await open(path, 'r')
  try {
    for (let size = 256 * 1024; size <= 64 * 1024 * 1024; size *= 4) {
      signal?.throwIfAborted()
      const bytes = Buffer.alloc(size)
      const read = await file.read(bytes, 0, size, 0)
      const result = parseGgufHeader(bytes.subarray(0, read.bytesRead))
      if (result.state === 'ok') return result.header
      if (result.state === 'bad') throw new Error(result.reason)
      if (read.bytesRead < size) break
    }
    throw new Error('The GGUF header is incomplete or larger than 64 MiB.')
  } finally { await file.close() }
}
export async function bankGgufModel(recipe: HostRecipe, folder: string, machineBytes: number, platform: NodeJS.Platform, signal?: AbortSignal): Promise<GgufModel> {
  const header = await localGgufHeader(join(bankModelPath(folder, recipe), recipe.weightFile!), signal)
  return ggufModelRow(recipe, header, machineBytes, platform)
}
export function withProjector(recipe: HostRecipe, file: HfFile): HostRecipe {
  const manifest = recipe.weightManifest!
  const files = [...manifest.files, file]
  return hostRecipeSchema.parse({ ...recipe, mmproj: file.path, weightsGb: files.reduce((sum, row) => sum + row.size, 0) / 1e9, weightManifest: hostWeightManifestSchema.parse({ ...manifest, files }) })
}
export async function listGgufModels(repo: string, options: HfHubOptions & { machineBytes: number; platform: NodeJS.Platform }): Promise<{ models: GgufModel[]; projectors: HfFile[] }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) throw new Error('Enter a Hugging Face repository id: author/model.')
  const tree = await fetchHuggingFaceRepo(repo, options)
  if (!tree.ok) throw new Error(tree.words)
  const projectors = tree.files.filter(file => /(^|\/)mmproj[^/]*\.gguf$/i.test(file.path))
  const groups = ggufQuantGroups(tree.files, true)
  if (!groups.length) throw new Error('This repository has no complete GGUF model. Choose a GGUF repository.')
  const template = HOST_RECIPES.find(recipe => recipe.engine === 'llamacpp')!
  const models: GgufModel[] = []
  for (const group of groups.sort((a, b) => b.bytes - a.bytes)) {
    options.signal?.throwIfAborted()
    const files = [...group.files].sort((a, b) => a.path.localeCompare(b.path))
    const first = files[0]!.path
    const include = first
    const source = 'https://huggingface.co/' + repo
    const manifestInput = { model: repo, revision: tree.revision, include, files }
    const manifest = hostWeightManifestSchema.parse(manifestInput)
    let recipe = hostRecipeSchema.parse({ image: template.image, cuda: template.cuda, install: template.install, engine: 'llamacpp', gpu: 'local', count: 1, vramGb: options.machineBytes / 1e9, diskGb: Math.max(1, group.bytes / 1e9), id: 'local-' + createHash('sha256').update(repo + '/' + first).digest('hex').slice(0, 20), label: repo + ' · ' + group.quant, model: repo, weightFile: first, mmproj: undefined, include, weightsGb: group.bytes / 1e9, weightManifest: manifest, source, verification: 'Hugging Face file manifest', verified: { by: 'unverified', source }, flags: [] })
    if (projectors.length === 1) recipe = withProjector(recipe, projectors[0]!)
    const read = await readGgufHeader(hubFileUrl(options.base ?? 'https://huggingface.co', repo, tree.revision!, first), options)
    models.push(ggufModelRow(recipe, read.ok ? read.header : undefined, options.machineBytes, options.platform, read.ok ? undefined : read.words))
  }
  return { models, projectors }
}
