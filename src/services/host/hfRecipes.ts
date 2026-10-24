import { z } from 'zod/v4'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isProofShapeRun } from '../../utils/privacyLevel.js'
import { resolveHuggingfaceApiKey } from '../providers/huggingface/huggingfaceAccounts.js'
import { HOST_RECIPES, type HostRecipe } from './recipes.js'
import { hostRecipeSchema, hostWeightManifestSchema, hostWeightPathSchema, rememberSessionHostRecipe } from './recipesFile.js'
import { checkGgufAgainstEngine, type GgufEngineCheck } from './ggufHeader.js'

export const HF_SEARCH_PLACEHOLDER = 'model name — e.g. deepseek, qwen, glm'
export const HF_SEARCH_LIMIT = 20
export const HF_OFFLINE_WORDS = 'Hugging Face is unreachable'
export const HF_PROOF_WORDS = 'Hugging Face search is off in this environment'
export const HF_GATED_WORDS = 'gated · sign in with /logins huggingface'
export const HF_RATE_LIMIT_WORDS = 'Hugging Face rate limit reached'
export const HF_NOT_CHAT_WORDS = '— not a chat model'
const HF_HUB = 'https://huggingface.co'
const HF_TIMEOUT_MS = 5000
const HF_SHAPES = [{ gpu: 'H100', vramGb: 80 }, { gpu: 'H200', vramGb: 141 }, { gpu: 'B200', vramGb: 180 }, { gpu: 'B300', vramGb: 288 }] as const
const HF_COUNTS = [1, 2, 4, 8] as const
const HF_SLOT_CONTEXT = 131072
const HF_PARALLEL = 4
const FOUR_BIT_QUANTS = ['Q4_K_M', 'UD-Q4_K_XL', 'Q4_K_L', 'Q4_K_S', 'Q4_K', 'IQ4_XS', 'UD-IQ4_XS', 'IQ4_NL', 'Q4_0', 'Q4_1']
const DTYPE_BYTES: Readonly<Record<string, number>> = { F64: 8, I64: 8, U64: 8, F32: 4, I32: 4, U32: 4, BF16: 2, F16: 2, I16: 2, U16: 2, F8_E4M3: 1, F8_E5M2: 1, F8_E8M0: 1, I8: 1, U8: 1, BOOL: 1 }
const EXPAND = ['downloads', 'gated', 'private', 'library_name', 'tags', 'safetensors', 'cardData', 'siblings', 'config', 'pipeline_tag', 'gguf']
const NOT_CHAT_TAGS: Readonly<Record<string, string>> = { 'image-text-to-text': 'vision', 'image-to-text': 'vision', 'visual-question-answering': 'vision', 'any-to-any': 'multimodal', 'feature-extraction': 'embeddings', 'sentence-similarity': 'embeddings', 'text-classification': 'classifier', 'token-classification': 'classifier', 'fill-mask': 'masked language model', 'text-to-image': 'image generation', 'text-to-speech': 'speech', 'automatic-speech-recognition': 'speech', 'audio-to-audio': 'audio', 'text-to-video': 'video', 'image-classification': 'vision', 'object-detection': 'vision', 'reinforcement-learning': 'policy', 'text-to-audio': 'audio', 'audio-classification': 'audio', 'zero-shot-image-classification': 'vision', 'image-feature-extraction': 'embeddings', 'translation': 'translation', 'summarization': 'summarisation', 'question-answering': 'extractive QA', 'text2text-generation': 'seq2seq' }

export interface HfModel {
  id: string
  downloads: number
  gated: boolean
  private: boolean
  library?: string
  pipeline?: string
  tags: string[]
  files: string[]
  params?: number
  dtypes: Record<string, number>
  license?: string
  ggufContext?: number
  config: Record<string, unknown>
}
interface HfFile { path: string; size: number; sha256?: string; git?: string }
export type HfSearchOutcome = { state: 'ready'; models: HfModel[] } | { state: 'offline'; words: string }
type HfRepoOutcome = { ok: true; files: HfFile[]; config: Record<string, unknown>; revision?: string } | { ok: false; words: string }
type HfDerivation = { ok: true; recipe: HostRecipe; engine: string; format: string; weightsGb: number } | { ok: false; reason: string }
export interface DerivedHfRecipe { repo: string; recipe: HostRecipe; engine: string; format: string; weightsGb: number; derivedAt: number; engineCheck?: string }
interface HfHubOptions { signal?: AbortSignal; token?: string; base?: string; timeoutMs?: number }
type HfEngineCheck = (base: string, repo: string, revision: string, weightFile: string, options: { token?: string; signal?: AbortSignal }) => Promise<GgufEngineCheck>
const VLLM_QUANT_METHODS = new Set(['awq', 'auto_awq', 'awq_marlin', 'gptq', 'auto_gptq', 'gptq_marlin', 'fp8', 'fbgemm_fp8', 'fp_quant', 'modelopt', 'modelopt_fp4', 'modelopt_mxfp8', 'modelopt_mixed', 'compressed-tensors', 'experts_int8', 'quark', 'moe_wna16', 'torchao', 'inc', 'mxfp4', 'gpt_oss_mxfp4', 'deepseek_v4_fp8', 'mxfp8', 'humming', 'bitsandbytes', 'gguf'])
const EXL_FORMATS: Readonly<Record<string, string>> = { exl2: 'EXL2', exl3: 'EXL3' }
export const HF_LOOK_FOR_WORDS = 'look for a GGUF, FP8, AWQ or GPTQ copy'

const modelSchema = z.object({
  id: z.string().min(1),
  downloads: z.number().nullable().optional(),
  gated: z.union([z.boolean(), z.string()]).nullable().optional(),
  private: z.boolean().nullable().optional(),
  library_name: z.string().nullable().optional(),
  pipeline_tag: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  siblings: z.array(z.object({ rfilename: z.string() })).nullable().optional(),
  safetensors: z.object({ parameters: z.record(z.string(), z.number()).nullable().optional(), total: z.number().nullable().optional() }).nullable().optional(),
  gguf: z.object({ total: z.number().nullable().optional(), context_length: z.number().nullable().optional() }).nullable().optional(),
  cardData: z.object({ license: z.union([z.string(), z.array(z.string())]).nullable().optional(), license_name: z.string().nullable().optional() }).nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
})
const treeSchema = z.array(z.object({ type: z.string(), path: hostWeightPathSchema, oid: z.string().optional(), size: z.number().int().nonnegative().nullable().optional(), lfs: z.object({ size: z.number().int().nonnegative(), oid: z.string().optional() }).nullable().optional() }))

const derived = new Map<string, DerivedHfRecipe>()

export function huggingFaceHubBase(): string | undefined {
  return flagEnv('MERCURY_HOST_HF_API_BASE')?.trim() || undefined
}
export function huggingFaceToken(): string | undefined {
  try { return resolveHuggingfaceApiKey()?.key } catch { return undefined }
}
const darkInProof = (options: HfHubOptions): boolean => !options.base && isProofShapeRun()
const timeoutSignal = (options: HfHubOptions): AbortSignal => {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? HF_TIMEOUT_MS)
  return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
}
async function hubGet(path: string, options: HfHubOptions, accept = 'application/json'): Promise<Response> {
  const base = (options.base ?? HF_HUB).replace(/\/+$/, '')
  return fetch(base + path, { method: 'GET', headers: { Accept: accept, ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}) }, redirect: 'error', signal: timeoutSignal(options) })
}
function hfRateLimitWords(response: Response, options: HfHubOptions): string {
  const reset = /\bt=(\d+)/.exec(response.headers.get('ratelimit') ?? '')?.[1] ?? /^\d+$/.exec(response.headers.get('retry-after')?.trim() ?? '')?.[0]
  return HF_RATE_LIMIT_WORDS + (reset ? ' · resets in ' + reset + ' s' : '') + (options.token ? '' : ' · sign in with /logins huggingface for a higher limit')
}
const licenceWords = (row: z.infer<typeof modelSchema>): string | undefined => {
  const card = row.cardData?.license
  const named = Array.isArray(card) ? card.join('/') : card ?? row.tags?.find(tag => tag.startsWith('license:'))?.slice(8)
  if (!named) return undefined
  if (named === 'other' && row.cardData?.license_name) return row.cardData.license_name
  return named === 'mit' ? 'MIT' : named.replace(/^apache-/, 'Apache-').replace(/^gpl/, 'GPL').replace(/^cc-/, 'CC-')
}
function hfModel(row: z.infer<typeof modelSchema>): HfModel {
  const dtypes = Object.fromEntries(Object.entries(row.safetensors?.parameters ?? {}).filter(([, count]) => Number.isFinite(count) && count > 0))
  const params = row.safetensors?.total ?? row.gguf?.total ?? (Object.keys(dtypes).length ? Object.values(dtypes).reduce((sum, count) => sum + count, 0) : undefined)
  return {
    id: row.id, downloads: row.downloads ?? 0, gated: Boolean(row.gated), private: Boolean(row.private),
    ...(row.library_name ? { library: row.library_name } : {}), ...(row.pipeline_tag ? { pipeline: row.pipeline_tag } : {}),
    tags: row.tags ?? [], files: (row.siblings ?? []).map(file => file.rfilename), ...(params ? { params } : {}), dtypes,
    ...(licenceWords(row) ? { license: licenceWords(row) } : {}), ...(row.gguf?.context_length ? { ggufContext: row.gguf.context_length } : {}),
    config: row.config ?? {},
  }
}

export async function searchHuggingFace(query: string, options: HfHubOptions = {}): Promise<HfSearchOutcome> {
  if (darkInProof(options)) return { state: 'offline', words: HF_PROOF_WORDS }
  const params = new URLSearchParams([['search', query], ['pipeline_tag', 'text-generation'], ['sort', 'downloads'], ['limit', String(HF_SEARCH_LIMIT)], ...EXPAND.map(key => ['expand', key])])
  try {
    const response = await hubGet('/api/models?' + params.toString(), options)
    if (response.status === 429) return { state: 'offline', words: hfRateLimitWords(response, options) }
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const rows = z.array(z.unknown()).parse(await response.json())
    const models = rows.map(row => modelSchema.safeParse(row)).filter(row => row.success).map(row => hfModel(row.data))
    return { state: 'ready', models: models.sort((a, b) => b.downloads - a.downloads) }
  } catch {
    return { state: 'offline', words: HF_OFFLINE_WORDS }
  }
}

export async function fetchHuggingFaceRepo(id: string, options: HfHubOptions = {}): Promise<HfRepoOutcome> {
  if (darkInProof(options)) return { ok: false, words: HF_PROOF_WORDS }
  const repoPath = id.split('/').map(encodeURIComponent).join('/')
  try {
    const info = await hubGet('/api/models/' + repoPath + '?expand=sha', options)
    if (info.status === 401 || info.status === 403) return { ok: false, words: 'gated · your Hugging Face account has no access to ' + id + ' · accept its terms at https://huggingface.co/' + id }
    if (info.status === 429) return { ok: false, words: hfRateLimitWords(info, options) + ' · nothing was derived' }
    if (!info.ok) throw new Error('HTTP ' + info.status)
    const revision = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(await info.json()).sha
    const files: HfFile[] = []
    let next: string | undefined = '/api/models/' + repoPath + '/tree/' + revision + '?recursive=true&limit=1000'
    const pages = new Set<string>()
    while (next) {
      if (pages.has(next)) throw new Error('Repeated file-list page')
      pages.add(next)
      const response = await hubGet(next, options)
      if (response.status === 401 || response.status === 403) return { ok: false, words: 'gated · your Hugging Face account has no access to ' + id + ' · accept its terms at https://huggingface.co/' + id }
      if (response.status === 429) return { ok: false, words: hfRateLimitWords(response, options) + ' · nothing was derived' }
      if (!response.ok) throw new Error('HTTP ' + response.status)
      for (const entry of treeSchema.parse(await response.json())) if (entry.type === 'file') files.push({ path: entry.path, size: entry.lfs?.size ?? entry.size ?? 0, ...(entry.lfs?.oid ? { sha256: entry.lfs.oid } : entry.oid ? { git: entry.oid } : {}) })
      const link = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
      const url = link ? new URL(link, options.base ?? HF_HUB) : undefined
      if (url && (url.origin !== new URL(options.base ?? HF_HUB).origin || url.pathname !== '/api/models/' + repoPath + '/tree/' + revision)) throw new Error('File-list page changed repository or revision')
      next = url ? url.pathname + url.search : undefined
    }
    let config: Record<string, unknown> = {}
    if (files.some(file => file.path === 'config.json')) {
      const response = await hubGet('/' + repoPath + '/raw/' + revision + '/config.json', options, 'text/plain')
      if (response.status === 429) return { ok: false, words: hfRateLimitWords(response, options) + ' · nothing was derived' }
      if (response.ok) config = z.record(z.string(), z.unknown()).parse(JSON.parse(await response.text()))
      else if (response.status !== 404) throw new Error('HTTP ' + response.status)
    }
    return { ok: true, files, config, revision }
  } catch {
    return { ok: false, words: 'Hugging Face is unreachable · nothing was derived' }
  }
}

const shortCount = (count: number): string => count >= 1e6 ? (count / 1e6).toFixed(count >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : count >= 1e3 ? (count / 1e3).toFixed(count >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(count)
const hfParamWords = (params?: number): string => params === undefined ? 'size unknown' : params >= 1e12 ? (params / 1e12).toFixed(1).replace(/\.0$/, '') + 'T' : params >= 1e9 ? Math.round(params / 1e9) + 'B' : params >= 1e6 ? Math.round(params / 1e6) + 'M' : String(params)
const quantOf = (path: string): string | undefined => {
  const stem = path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '')
  const folder = stem.includes('/') ? stem.slice(0, stem.lastIndexOf('/')).split('/').pop()! : ''
  const tag = /^(?:UD-)?(?:IQ|Q)\d(?:_[A-Z0-9]+)*$|^(?:BF16|F16|F32|MXFP4|NVFP4)$/i
  if (tag.test(folder)) return folder.toUpperCase()
  const found = stem.split('/').pop()!.match(/(?:UD-)?(?:IQ|Q)\d(?:_[A-Z0-9]+)*|(?<![A-Z0-9])(?:BF16|F16|F32|MXFP4|NVFP4)(?![A-Z0-9])/gi)
  return found?.at(-1)?.toUpperCase()
}
const isGgufWeight = (path: string): boolean => /\.gguf$/i.test(path) && !/(^|\/)mmproj/i.test(path)
const isSafetensorsWeight = (path: string): boolean => /\.safetensors$/i.test(path) && !/(^|\/)(original|consolidated)\//i.test(path)
function quantGroups(files: readonly HfFile[]): { quant: string; files: HfFile[]; bytes: number }[] {
  const groups = new Map<string, { quant: string; files: HfFile[]; bytes: number }>()
  for (const file of files) {
    if (!isGgufWeight(file.path)) continue
    const quant = quantOf(file.path)
    if (!quant) continue
    const sharded = /-\d{5}-of-\d{5}\.gguf$/i.test(file.path)
    const key = (file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '') + '|' + quant + '|' + file.path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '') + '|' + (sharded ? 'shards' : 'single')
    const group = groups.get(key) ?? { quant, files: [], bytes: 0 }
    group.files.push(file)
    group.bytes += file.size
    groups.set(key, group)
  }
  return [...groups.values()].filter(group => {
    const shards = group.files.map(file => /-(\d{5})-of-(\d{5})\.gguf$/i.exec(file.path)).filter(Boolean)
    if (!shards.length) return group.files.length === 1
    const total = Number(shards[0]![2])
    const parts = shards.map(shard => Number(shard![1]))
    return shards.length === total && shards.length === group.files.length && new Set(parts).size === total && parts.every(part => part >= 1 && part <= total) && shards.every(shard => Number(shard![2]) === total)
  })
}
export function chooseGgufQuant(files: readonly HfFile[]): { quant: string; files: HfFile[]; bytes: number } | undefined {
  const groups = quantGroups(files)
  const preferred = FOUR_BIT_QUANTS.map(quant => groups.find(group => group.quant === quant)).find(Boolean)
  return preferred ?? [...groups].sort((a, b) => b.bytes - a.bytes)[0]
}
const notChatReason = (model: HfModel): string | undefined => {
  const pipeline = model.pipeline && model.pipeline !== 'text-generation' ? NOT_CHAT_TAGS[model.pipeline] ?? model.pipeline : undefined
  if (pipeline) return pipeline
  const tagged = model.tags.map(tag => NOT_CHAT_TAGS[tag]).find(Boolean)
  if (tagged && !model.tags.includes('text-generation')) return tagged
  const architectures = Array.isArray(model.config.architectures) ? (model.config.architectures as unknown[]).map(String) : []
  if (architectures.length && architectures.every(name => /ForConditionalGeneration|Vision|ForImage|Embedding|ForSequenceClassification|ForTokenClassification|ForMaskedLM|Encoder$/i.test(name))) return 'vision or encoder'
  if (!model.files.some(path => isGgufWeight(path) || isSafetensorsWeight(path))) return 'no weight files'
  return undefined
}
export const hfModelChat = (model: HfModel): { ok: true } | { ok: false; reason: string } => { const reason = notChatReason(model); return reason ? { ok: false, reason } : { ok: true } }
function hfFormatWords(model: HfModel): string {
  if (model.files.some(isGgufWeight) || model.library === 'gguf') {
    const quant = chooseGgufQuant(model.files.map(path => ({ path, size: 0 })).filter(file => isGgufWeight(file.path)))
    return 'GGUF' + (quant ? ' ' + quant.quant : '')
  }
  const quantization = model.config.quantization_config as { quant_method?: unknown; quant_algo?: unknown } | undefined
  const method = typeof quantization?.quant_method === 'string' ? quantization.quant_method : undefined
  const dominant = Object.entries(model.dtypes).sort((a, b) => b[1] - a[1])[0]?.[0]
  const dtype = dominant === 'F8_E4M3' || dominant === 'F8_E5M2' ? 'FP8' : dominant === 'BF16' ? 'BF16' : dominant === 'F16' ? 'FP16' : dominant === 'F32' ? 'FP32' : dominant === 'I8' || dominant === 'U8' ? '8-bit' : undefined
  const word = method === 'fp8' ? 'FP8' : method === 'mxfp4' ? 'MXFP4' : method === 'modelopt' ? (String(quantization?.quant_algo ?? '').includes('FP4') ? 'NVFP4' : 'FP8') : method && method !== 'compressed-tensors' ? method.toUpperCase() : dtype
  return 'safetensors' + (word ? ' ' + word : '')
}
export function hfRowLabel(model: HfModel, width = 0): string {
  const chat = hfModelChat(model)
  const head = model.id.padEnd(width)
  if (!chat.ok) return head + ' · ' + HF_NOT_CHAT_WORDS + ' (' + chat.reason + ') · ↓ ' + shortCount(model.downloads)
  return [head, ...(model.params ? [hfParamWords(model.params)] : []), hfFormatWords(model), '↓ ' + shortCount(model.downloads), ...(model.license ? [model.license] : []), ...(model.gated ? ['gated'] : []), ...(model.private ? ['private'] : [])].join(' · ')
}
export function hfRecipeSourceWords(recipe: HostRecipe): string | undefined {
  if (recipe.verified.by !== 'unverified' || !recipe.id.startsWith('hf-') && !/derived from the repo/.test(recipe.verification + ' ' + (recipe.verified.note ?? ''))) return
  const format = recipe.label.split(' · ').slice(1).filter(word => word !== 'found on Hugging Face' && word !== 'not booted by Mercury').join(' · ')
  return format || 'Hugging Face'
}
const smallestShape = (needGb: number): { gpu: string; vramGb: number; count: number } | undefined => HF_SHAPES.flatMap(shape => HF_COUNTS.map(count => ({ ...shape, count }))).filter(shape => shape.vramGb * shape.count >= needGb).sort((a, b) => a.vramGb * a.count - b.vramGb * b.count || a.count - b.count)[0]
const diskFor = (weightsGb: number): number => Math.max(50, Math.ceil((weightsGb * 1.25 + 40) / 50) * 50)
const slug = (id: string): string => id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '')
const today = (): string => new Date().toISOString().slice(0, 10)
const commonPrefix = (paths: readonly string[]): string => paths.reduce((prefix, path) => { let at = 0; while (at < prefix.length && at < path.length && prefix[at] === path[at]) at++; return prefix.slice(0, at) })

export function unloadableQuantisation(model: HfModel, config: Record<string, unknown> = {}, files: readonly HfFile[] = []): string | undefined {
  const quantization = (config.quantization_config ?? model.config.quantization_config) as { quant_method?: unknown } | undefined
  const method = typeof quantization?.quant_method === 'string' ? quantization.quant_method.trim().toLowerCase() : undefined
  const library = (model.library ?? '').toLowerCase()
  const exl = (method && EXL_FORMATS[method]) ?? (library === 'exllamav3' || model.tags.includes('exl3') || files.some(file => file.path === 'exl3_k_map.json') ? 'EXL3' : library === 'exllamav2' || model.tags.includes('exl2') ? 'EXL2' : undefined)
  if (exl) return 'this file is an ' + exl + ' quantisation; none of Mercury’s engines (vLLM, SGLang, llama.cpp) run it — ' + HF_LOOK_FOR_WORDS
  if (method && !VLLM_QUANT_METHODS.has(method)) return 'this file is a ' + method.toUpperCase() + ' quantisation, which vLLM does not load — ' + HF_LOOK_FOR_WORDS
  return undefined
}

function withWeightManifest(recipe: HostRecipe, files: readonly HfFile[], revision?: string): HostRecipe {
  const candidate = { model: recipe.model, include: recipe.include ?? '', revision, files }
  const manifest = hostWeightManifestSchema.safeParse(candidate)
  if (!manifest.success) return recipe
  return { ...recipe, weightsGb: files.reduce((sum, file) => sum + file.size, 0) / 1e9, weightManifest: manifest.data }
}

export function deriveHostRecipe(model: HfModel, files: readonly HfFile[], config: Record<string, unknown> = {}, revision?: string): HfDerivation {
  const chat = hfModelChat({ ...model, config: { ...model.config, ...config } })
  if (!chat.ok) return { ok: false, reason: HF_NOT_CHAT_WORDS + ' (' + chat.reason + ')' }
  const source = 'https://huggingface.co/' + model.id
  const verified = { by: 'unverified' as const, on: today(), note: "derived from the repo's config and file list; nobody has booted this recipe", source }
  const gguf = chooseGgufQuant(files)
  const safetensors = files.filter(file => isSafetensorsWeight(file.path))
  if (!gguf && !safetensors.length) return { ok: false, reason: HF_NOT_CHAT_WORDS + ' (no GGUF or safetensors weights)' }
  const repoBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (gguf) {
    const shipped = HOST_RECIPES.find(row => row.engine === 'llamacpp' && row.install && row.image)
    if (!shipped) return { ok: false, reason: 'no llama.cpp image is shipped' }
    if (gguf.bytes <= 0) return { ok: false, reason: 'the repo lists no file sizes' }
    const weightsGb = gguf.bytes / 1e9
    const shape = smallestShape(weightsGb * 1.2)
    if (!shape) return { ok: false, reason: 'needs more than 8× B300 (' + Math.ceil(weightsGb * 1.2) + ' GB) · no single-machine recipe' }
    const slot = model.ggufContext ?? HF_SLOT_CONTEXT
    const paths = gguf.files.map(file => file.path).sort()
    const first = paths.find(path => /-00001-of-\d{5}\.gguf$/i.test(path)) ?? paths[0]!
    const format = 'GGUF ' + gguf.quant
    const recipe: HostRecipe = {
      id: 'hf-' + slug(model.id), label: model.id + ' · ' + format, model: model.id, gpu: shape.gpu, count: shape.count, vramGb: shape.vramGb, diskGb: diskFor(weightsGb), weightsGb,
      engine: 'llamacpp', image: shipped.image, cuda: shipped.cuda, ...(shipped.imageSource ? { imageSource: shipped.imageSource } : {}), install: shipped.install!, source,
      verification: 'unverified · derived from the repo · llama.cpp (' + format + ') · not booted', verified,
      context: slot, contextPerSlot: slot,
      include: paths.length === 1 ? first : commonPrefix(paths) + '*', weightFile: first,
      flags: ['--n-gpu-layers', 'all', '--jinja', '--ctx-size', String(slot * HF_PARALLEL), '--parallel', String(HF_PARALLEL), '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-reuse', '256'],
    }
    const trusted = hostRecipeSchema.parse(withWeightManifest(recipe, gguf.files, revision))
    return { ok: true, recipe: trusted, engine: 'llama.cpp', format, weightsGb: trusted.weightsGb }
  }
  const unloadable = unloadableQuantisation(model, config, files)
  if (unloadable) return { ok: false, reason: unloadable }
  const fileBytes = safetensors.reduce((sum, file) => sum + file.size, 0)
  const dtypeBytes = Object.entries(model.dtypes).reduce((sum, [dtype, count]) => sum + count * (DTYPE_BYTES[dtype] ?? 2), 0)
  const bytes = dtypeBytes > 0 ? dtypeBytes : fileBytes
  if (bytes <= 0) return { ok: false, reason: 'the repo lists no weight sizes' }
  const weightsGb = (fileBytes > 0 ? fileBytes : bytes) / 1e9
  const shape = smallestShape(bytes * 1.2 / 1e9)
  if (!shape) return { ok: false, reason: 'needs more than 8× B300 (' + Math.ceil(bytes * 1.2 / 1e9) + ' GB) · no single-machine recipe' }
  const maxPositions = Number((config.max_position_embeddings ?? model.config.max_position_embeddings) as unknown)
  const context = Number.isSafeInteger(maxPositions) && maxPositions > 0 ? maxPositions : undefined
  const format = hfFormatWords({ ...model, config: { ...model.config, ...config } })
  const recipe: HostRecipe = {
    id: 'hf-' + slug(model.id), label: model.id + ' · ' + format, model: model.id, gpu: shape.gpu, count: shape.count, vramGb: shape.vramGb, diskGb: diskFor(Math.max(weightsGb, repoBytes / 1e9)), weightsGb,
    engine: 'vllm', image: 'vllm/vllm-openai:latest', cuda: '13.0', source,
    verification: 'unverified · derived from the repo · vLLM (' + format + ') · not booted', verified,
    ...(context ? { context, contextPerSlot: context } : {}),
    flags: [...(context ? ['--max-model-len', String(context)] : []), '--tensor-parallel-size', String(shape.count), ...(model.tags.includes('custom_code') ? ['--trust-remote-code'] : [])],
  }
  const trusted = hostRecipeSchema.parse(withWeightManifest(recipe, files, revision))
  return { ok: true, recipe: trusted, engine: 'vLLM', format, weightsGb: trusted.weightsGb }
}

export function derivedHfRecipe(repo: string): DerivedHfRecipe | undefined {
  return derived.get(repo)
}
function derivedHfRecipeOf(recipe: HostRecipe): DerivedHfRecipe | undefined {
  return derived.get(recipe.model)?.recipe.id === recipe.id ? derived.get(recipe.model) : undefined
}
export function forgetDerivedHfRecipes(): void {
  derived.clear()
}
export function derivedRecipeWords(recipe: HostRecipe, _now = Date.now()): string | undefined {
  const row = derivedHfRecipeOf(recipe)
  return row ? row.engine + ' · ' + row.format + ' · ' + Math.round(row.weightsGb) + ' GB' : undefined
}

export async function pickHuggingFaceModel(model: HfModel, options: HfHubOptions & { fetchRepo?: (id: string, options: HfHubOptions) => Promise<HfRepoOutcome>; checkEngine?: HfEngineCheck } = {}): Promise<{ ok: true; row: DerivedHfRecipe } | { ok: false; words: string }> {
  const known = derived.get(model.id)
  if (known) return { ok: true, row: known }
  const chat = hfModelChat(model)
  if (!chat.ok) return { ok: false, words: model.id + ' · ' + HF_NOT_CHAT_WORDS + ' (' + chat.reason + ')' }
  if (model.gated && !options.token) return { ok: false, words: model.id + ' · ' + HF_GATED_WORDS }
  const repo = await (options.fetchRepo ?? fetchHuggingFaceRepo)(model.id, options)
  if (!repo.ok) return { ok: false, words: model.id + ' · ' + repo.words }
  const derivation = deriveHostRecipe(model, repo.files, repo.config, repo.revision)
  if (!derivation.ok) return { ok: false, words: model.id + ' · ' + derivation.reason }
  let recipe = derivation.recipe
  let engineCheck: string | undefined
  if (recipe.engine === 'llamacpp' && recipe.weightFile) {
    const check = options.checkEngine ? await options.checkEngine(options.base ?? HF_HUB, model.id, repo.revision ?? 'main', recipe.weightFile, { token: options.token, signal: options.signal })
      : darkInProof(options) ? { state: 'unread' as const, words: 'engine check skipped · ' + HF_PROOF_WORDS }
      : await checkGgufAgainstEngine(options.base ?? HF_HUB, model.id, repo.revision ?? 'main', recipe.weightFile, { token: options.token, signal: options.signal })
    if (check.state === 'unknown') return { ok: false, words: model.id + ' · ' + check.words }
    engineCheck = check.words
    recipe = { ...recipe, verification: recipe.verification + ' · ' + (check.state === 'known' ? 'header checked against the engine' : 'header unread') }
  }
  const row: DerivedHfRecipe = { repo: model.id, recipe: rememberSessionHostRecipe(recipe), engine: derivation.engine, format: derivation.format, weightsGb: derivation.weightsGb, derivedAt: Date.now(), ...(engineCheck ? { engineCheck } : {}) }
  derived.set(model.id, row)
  return { ok: true, row }
}
