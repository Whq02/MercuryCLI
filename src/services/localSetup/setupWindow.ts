import { kvGeometryOf, type KvGeometry } from '../localServer/localServerMemory.js'
import { parseOllamaTags } from '../localServer/localServerTruth.js'
import { fitLocalWindow, fitLocalWindowOn, localWindowFitWords, type LocalWindowFit } from '../localServer/localWindowFit.js'
import { num, readJson, rec, resolveSetupIo, str } from './setupIo.js'
import type { SetupIo, WindowChoice } from './setupTypes.js'

export function windowWords(choice: Omit<LocalWindowFit, 'words'>): string {
  return localWindowFitWords(choice)
}

export function chooseWindowFrom(args: { tag: string; weightsBytes: number; geometry: KvGeometry; trainedMax?: number; machineBytes: number; usableBytes: number; usableSource?: string; slots: number; cacheType?: string }): WindowChoice {
  const { tag, ...input } = args
  return { ...fitLocalWindow({ name: tag, ...input }), tag }
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
  const truth = await io.readTruth()
  const fit = fitLocalWindowOn(truth, { name: tag, weightsBytes: listed.sizeBytes, geometry, ...(trainedMax !== undefined ? { trainedMax } : {}) }, io.parallelSlots, io.cacheType)
  const choice: WindowChoice = { ...fit, tag }
  io.writeWindow(tag, choice.window)
  return choice
}
