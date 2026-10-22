import type { HostRecipe } from './recipes.js'

export const heavyWeights = (recipe: HostRecipe): boolean => recipe.weightsGb > 512

export const HOST_UNBILLED_STATUSES: ReadonlySet<string> = new Set(['EXITED', 'TERMINATED'])
export const hostPodBills = (pod: { status: string }): boolean => !HOST_UNBILLED_STATUSES.has(pod.status)
export function hostSpendSoFar(pods: readonly { status: string; cost: number; startedAt?: string | null; createdAt: string }[], now = Date.now()): number {
  return pods.filter(hostPodBills).reduce((sum, pod) => sum + pod.cost * Math.max(0, now - Date.parse(pod.startedAt ?? pod.createdAt)) / 3600_000, 0)
}

function hostSize(gb: number): string {
  return gb >= 1000 ? +(gb / 1000).toFixed(2) + ' TB' : +gb.toFixed(2) + ' GB'
}

function hostDownloadWords(recipe: HostRecipe): string {
  if (!heavyWeights(recipe)) return ''
  const fast = Math.ceil(recipe.weightsGb / 60 / 10) * 10
  const slow = Math.ceil(recipe.weightsGb / 30 / 10) * 10
  return 'weights ' + hostSize(recipe.weightsGb) + ' — download alone ~' + fast + '–' + slow + ' min assuming sustained 0.5–1 GB/s' + ((recipe.nodes ?? 1) > 1 ? ' per node (a full copy on each)' : '')
}

function hostPerTokenWords(recipe: HostRecipe, price?: number): string {
  const vendor = recipe.model === 'moonshotai/Kimi-K3' ? ['Kimi', 'https://platform.kimi.ai']
    : /^(Qwen|RadixArk)\/Qwen3\.8-2\.4T-A95B/.test(recipe.model) ? ['Qwen Cloud', 'https://www.qwencloud.com']
    : recipe.model.startsWith('zai-org/GLM-5.3') ? ['Z.AI', 'https://z.ai']
    : recipe.model.startsWith('deepseek-ai/DeepSeek-V4-Pro') ? ['DeepSeek', 'https://www.deepseek.com/']
    : recipe.model.startsWith('XiaomiMiMo/MiMo-V2.6') ? ['Xiaomi MiMo', 'https://platform.xiaomimimo.com'] : undefined
  return vendor ? 'also served per token by ' + vendor[0] + ' (' + vendor[1] + ') — ' + (price === undefined ? 'a rented machine' : 'a $' + price.toFixed(2) + '/hr machine') + ' is cheaper only when kept busy' : ''
}

export function hostShortStorageWords(recipe: HostRecipe): string {
  if (!heavyWeights(recipe)) return ''
  const fast = Math.ceil(recipe.weightsGb / 60 / 10) * 10
  const slow = Math.ceil(recipe.weightsGb / 30 / 10) * 10
  return '+ ' + ((recipe.nodes ?? 1) > 1 ? recipe.nodes + ' × ' : '') + hostSize(recipe.diskGb) + ' disk · weights ' + hostSize(recipe.weightsGb) + ' · download ~' + fast + '–' + slow + ' min' + ((recipe.nodes ?? 1) > 1 ? ' per node · no Stop' : '')
}

export function hostStorageWords(recipe: HostRecipe, price?: number): string {
  if (!heavyWeights(recipe)) return recipe.diskGb + ' GB disk (extra). Billing starts now.'
  return '+ ' + ((recipe.nodes ?? 1) > 1 ? recipe.nodes + ' × ' : '') + hostSize(recipe.diskGb) + ' disk (extra) · ' + hostDownloadWords(recipe) + '; loading is additional; billing starts now; ' + ((recipe.nodes ?? 1) > 1 ? 'a cluster has no Stop and bills until Terminate; cluster networking is additional; cluster GPUs can bill above this catalogue rate (runpod.io/pricing)' : 'a stopped pod still bills its disk') + '. ' + hostPerTokenWords(recipe, price)
}

export const hostSetupTimeout = (recipe?: HostRecipe): number => 90 * 60_000 + Math.ceil((recipe?.weightsGb ?? 0) / 0.5) * 1000

export function hostPriceLines(recipe: HostRecipe, price?: number): string[] | undefined {
  if (!heavyWeights(recipe)) return undefined
  const download = hostDownloadWords(recipe).split(' — ')[1]!.split(' assuming ')[0]!
  const vendor = hostPerTokenWords(recipe, price).split(' — ')
  if ((recipe.nodes ?? 1) > 1) return [
    recipe.nodes + ' × ' + hostSize(recipe.diskGb) + ' disk (extra) · weights ' + hostSize(recipe.weightsGb),
    'each node downloads all ' + hostSize(recipe.weightsGb) + ': ' + download.replace('download alone ', '') + ' at a sustained 0.5–1 GB/s',
    'Billing starts now; a cluster has no Stop — it bills until Terminate.',
    'Loading is additional; cluster networking bills extra.',
    'Cluster GPUs can bill above this catalogue rate (runpod.io/pricing).',
    ...vendor.filter(Boolean),
  ]
  return [
    hostSize(recipe.diskGb) + ' disk (extra) · weights ' + hostSize(recipe.weightsGb),
    download + '; assumes sustained 0.5–1 GB/s',
    'Loading is additional; a stopped pod still bills its disk.',
    'Billing starts now, including while weights download.',
    ...vendor.filter(Boolean),
  ]
}
