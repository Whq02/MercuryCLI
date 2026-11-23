import { mkdirSync } from 'node:fs'
import { bankDownloadScript, bankModelPath, bytesWords, folderBytes, sealBank } from './bank.js'
import { runBoxScript } from './boxExecution.js'
import type { HostRecipe } from './recipes.js'
import { hostRunner, type HostRunner } from './ssh.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startInterval, stopInterval } from '../../platform/async/timers.js'
import { hostOsFamily } from '../../platform/host-os/programs.js'

export async function pullIntoBank(recipe: HostRecipe, folder: string, options: { signal: AbortSignal; token?: string; runner?: HostRunner; progress?: (words: string) => void; hashProgress?: (words: string) => void; pollMs?: number }): Promise<Awaited<ReturnType<typeof sealBank>>> {
  const path = bankModelPath(folder, recipe)
  mkdirSync(path, { recursive: true })
  const mark = options.progress ?? (() => {})
  const progress = startInterval(() => { try { mark('downloading ' + bytesWords(folderBytes(path)) + ' of ' + bytesWords(recipe.weightsGb * 1e9)) } catch (error) { passedOver(error) } }, options.pollMs ?? 1000)
  try {
    await runBoxScript({ os: hostOsFamily(), target: undefined }, bankDownloadScript(recipe, path), options.runner ?? hostRunner, options.signal, 12 * 3600_000, options.token ? { HF_TOKEN: options.token } : undefined)
    stopInterval(progress)
    return await sealBank(recipe, folder, options.signal, options.hashProgress ?? mark)
  } catch (error) {
    if (!options.token) throw error
    throw new Error((error instanceof Error ? error.message : String(error)).split(options.token).join('[redacted]'))
  } finally { stopInterval(progress) }
}
