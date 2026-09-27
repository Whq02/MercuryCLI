import { gibWords, kvGeometryOf, projectLoad, tokensWords, type KvGeometry } from '../localServer/localServerMemory.js'
import { parseOllamaTags } from '../localServer/localServerTruth.js'
import { num, readJson, rec, resolveSetupIo, str } from './setupIo.js'
import { SETUP_USABLE_FRACTION, SETUP_WINDOW_LADDER, type SetupIo, type WindowChoice } from './setupTypes.js'

export function windowWords(choice: Omit<WindowChoice, 'words'>): string {
  const slots = choice.slots > 1 ? `, ${choice.slots} slots` : ''
  const box = `${gibWords(choice.machineBytes)} box${slots}`
  const parts = `${gibWords(choice.weightsBytes)} weights + ${gibWords(choice.cacheBytes)} cache`
  if (choice.fits) return `${tokensWords(choice.window)} · ${parts} of ${gibWords(choice.usableBytes)} usable (${box})`
  return `${tokensWords(choice.window)} · ${parts} — ${gibWords(choice.totalBytes)} does not fit in ${gibWords(choice.usableBytes)} usable (${box})`
}

export function chooseWindowFrom(args: { tag: string; weightsBytes: number; geometry: KvGeometry; trainedMax?: number; machineBytes: number; slots: number; cacheType?: string }): WindowChoice {
  const usableBytes = Math.floor(args.machineBytes * SETUP_USABLE_FRACTION)
  const slots = Math.max(1, Math.floor(args.slots))
  const rungs = SETUP_WINDOW_LADDER.filter(w => args.trainedMax === undefined || w <= args.trainedMax)
  if (rungs.length === 0 && args.trainedMax !== undefined) rungs.push(args.trainedMax)
  const model = { name: args.tag, weightsBytes: args.weightsBytes, geometry: args.geometry }
  const ladder = rungs.map(window => {
    const projected = projectLoad(model, window, slots, args.cacheType)
    return { window, totalBytes: projected.totalBytes, fits: projected.totalBytes <= usableBytes }
  })
  const fitting = ladder.filter(r => r.fits)
  const chosen = fitting.length > 0 ? fitting[fitting.length - 1]! : ladder[0]!
  const projected = projectLoad(model, chosen.window, slots, args.cacheType)
  const choice: Omit<WindowChoice, 'words'> = {
    tag: args.tag,
    window: chosen.window,
    fits: chosen.fits,
    weightsBytes: args.weightsBytes,
    cacheBytes: projected.cacheBytes,
    totalBytes: projected.totalBytes,
    usableBytes,
    machineBytes: args.machineBytes,
    ...(args.trainedMax !== undefined ? { trainedMax: args.trainedMax } : {}),
    slots,
    ladder,
  }
  return { ...choice, words: windowWords(choice) }
}

export async function chooseWindow(root: string, tag: string, seam: SetupIo = {}): Promise<WindowChoice> {
  const io = resolveSetupIo(seam)
  const [tags, show] = await Promise.all([readJson(io, `${root}/api/tags`), readJson(io, `${root}/api/show`, { model: tag })])
  const listed = parseOllamaTags(tags).find(m => m.name === tag)
  if (!listed) throw new Error(`${tag} is not listed by ${root}/api/tags`)
  if (listed.sizeBytes === undefined) throw new Error(`${root}/api/tags states no size for ${tag}`)
  const info = rec(rec(show)?.model_info)
  if (!info) throw new Error(`${root}/api/show gave no model_info for ${tag}`)
  const geometry = kvGeometryOf(info)
  if (!geometry) throw new Error(`the KV geometry of ${tag} could not be read from model_info`)
  const arch = str(info['general.architecture'])
  const trainedMax = (arch ? num(info[`${arch}.context_length`]) : undefined) ?? listed.trainedContext
  const choice = chooseWindowFrom({
    tag,
    weightsBytes: listed.sizeBytes,
    geometry,
    ...(trainedMax !== undefined ? { trainedMax } : {}),
    machineBytes: io.totalMemoryBytes,
    slots: io.parallelSlots,
    ...(io.cacheType !== undefined ? { cacheType: io.cacheType } : {}),
  })
  io.writeWindow(tag, choice.window)
  return choice
}
