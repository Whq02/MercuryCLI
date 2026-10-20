import type { HostRecipe } from './recipes.js'

export function hostSize(gb: number): string {
  return gb >= 1000 ? +(gb / 1000).toFixed(2) + ' TB' : +gb.toFixed(2) + ' GB'
}

export function hostDownloadWords(recipe: HostRecipe): string {
  if (!recipe.weightsGb) return ''
  const fast = Math.ceil(recipe.weightsGb / 60 / 10) * 10
  const slow = Math.ceil(recipe.weightsGb / 30 / 10) * 10
  return 'weights ' + hostSize(recipe.weightsGb) + ' — download alone ~' + fast + '–' + slow + ' min assuming sustained 0.5–1 GB/s' + ((recipe.nodes ?? 1) > 1 ? ' per node (a full copy on each)' : '')
}

export function hostPerTokenWords(recipe: HostRecipe, price?: number): string {
  const vendor = recipe.model === 'moonshotai/Kimi-K3' ? ['Kimi', 'https://platform.kimi.ai']
    : recipe.model.startsWith('zai-org/GLM-5.3') ? ['Z.AI', 'https://z.ai']
    : recipe.model.startsWith('deepseek-ai/DeepSeek-V4-Pro') ? ['DeepSeek', 'https://www.deepseek.com/']
    : recipe.model.startsWith('XiaomiMiMo/MiMo-V2.6') ? ['Xiaomi MiMo', 'https://platform.xiaomimimo.com'] : undefined
  return vendor ? 'also served per token by ' + vendor[0] + ' (' + vendor[1] + ') — ' + (price === undefined ? 'a rented machine' : 'a $' + price.toFixed(2) + '/hr machine') + ' is cheaper only when kept busy' : ''
}

export function hostStorageWords(recipe: HostRecipe, price?: number): string {
  if (!recipe.weightsGb) return recipe.diskGb + ' GB disk (extra). Ready may take 20–90 min; billing starts now.'
  return '+ ' + ((recipe.nodes ?? 1) > 1 ? recipe.nodes + ' × ' : '') + hostSize(recipe.diskGb) + ' disk (extra) · ' + hostDownloadWords(recipe) + '; loading is additional; billing starts now; a stopped pod still bills its disk' + ((recipe.nodes ?? 1) > 1 ? '; cluster networking is additional; clusters must be terminated to end billing' : '') + '. ' + hostPerTokenWords(recipe, price)
}

export const hostSetupTimeout = (recipe?: HostRecipe): number => 90 * 60_000 + Math.ceil((recipe?.weightsGb ?? 0) / 0.5) * 1000

export function hostPriceLines(recipe: HostRecipe, price?: number): string[] | undefined {
  if (!recipe.weightsGb) return undefined
  const download = hostDownloadWords(recipe).split(' — ')[1]!.split(' assuming ')[0]!
  const vendor = hostPerTokenWords(recipe, price).split(' — ')
  return [
    ((recipe.nodes ?? 1) > 1 ? recipe.nodes + ' × ' : '') + hostSize(recipe.diskGb) + ' disk (extra) · weights ' + hostSize(recipe.weightsGb),
    download + '; assumes sustained 0.5–1 GB/s' + ((recipe.nodes ?? 1) > 1 ? ' per node' : ''),
    'Loading is additional; a stopped pod still bills its disk.',
    (recipe.nodes ?? 1) > 1 ? 'Billing starts now; clusters and networking bill until Terminate.' : 'Billing starts now, including while weights download.',
    ...vendor.filter(Boolean),
  ]
}
