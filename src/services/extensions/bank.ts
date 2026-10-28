import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod/v4'
import { lock } from '../../utils/lockfile.js'
import { bankFolder, bankFree, bankModelFolder, readBankRegistry, verifyBank, writeBankRegistry } from '../host/bank.js'
import { hostRecipeSchema, hostWeightPathSchema } from '../host/recipesFile.js'
import { hostDirectory } from '../host/store.js'
import { bytesMatchRecipe, manifestBytes } from '../host/bankManifest.js'
import { volumeModel } from '../host/volumes.js'
import type { HostRecipe } from '../host/recipes.js'

const relative = hostWeightPathSchema.refine(path => !/^[A-Za-z]:/.test(path))
const recipe = hostRecipeSchema.refine(value => /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value.model), 'Invalid model name').refine(value => Boolean(value.weightManifest && value.weightManifest.model === value.model && value.weightManifest.include === (value.include ?? '') && bytesMatchRecipe(manifestBytes(value.weightManifest), value.weightsGb) && value.weightManifest.files.every(file => file.sha256 && relative.safeParse(file.path).success)), 'A SHA256 manifest is required').refine(value => [value.weightFile, value.mmproj, value.chatTemplateFile].every(path => path === undefined || relative.safeParse(path).success && value.weightManifest?.files.some(file => file.path === path)), 'Model files must be relative manifest members')
export const bankRequests = [
  z.strictObject({ version: z.literal(1), op: z.literal('bank.plan'), recipe, folder: z.string().min(1).optional() }),
  z.strictObject({ version: z.literal(1), op: z.literal('bank.register'), recipe, folder: z.string().min(1) }),
] as const
export type BankRequest = z.infer<(typeof bankRequests)[number]>
function destination(recipe: HostRecipe, requested?: string): { folder: string; path: string; key: string } {
  const named = requested ?? bankFolder()
  if (!named) throw new Error('Choose a Bank folder with --bank <folder>.')
  const folder = resolve(named), path = bankModelFolder(folder, recipe)
  if (dirname(path) !== folder) throw new Error('Invalid Bank model destination')
  return { folder, path, key: volumeModel(recipe) }
}
export async function externalBank(request: BankRequest, signal: AbortSignal): Promise<unknown> {
  const target = destination(request.recipe, request.folder)
  if (request.op === 'bank.plan') return { ...target, exists: existsSync(target.path) || Boolean(readBankRegistry().models[target.key]), free: bankFree(target.folder) ?? null }
  const release = await lock(hostDirectory(), { retries: 0, lockfilePath: join(hostDirectory(), 'external-bank.lock') })
  try {
    if (readBankRegistry().models[target.key]) throw new Error('Bank model already exists: ' + request.recipe.model)
    if (!lstatSync(target.path).isDirectory() || lstatSync(target.path).isSymbolicLink() || dirname(realpathSync(target.path)) !== realpathSync(target.folder)) throw new Error('Bank destination must be a regular directory')
    for (const name of ['SHA256SUMS', ...request.recipe.weightManifest!.files.map(file => file.path)]) {
      let path = target.path
      for (const part of name.split('/')) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) throw new Error('Bank files must not be symlinks') }
      if (!lstatSync(path).isFile()) throw new Error('Bank member is not a regular file')
    }
    signal.throwIfAborted()
    await verifyBank(request.recipe, target.folder, signal)
    writeBankRegistry({ ...readBankRegistry(), folder: target.folder })
    return { path: target.path, key: target.key, registered: true }
  } finally { await release() }
}
