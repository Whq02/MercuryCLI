import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod/v4'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import type { LlmHostRoad, LlmHostResult } from '../llmHost/index.js'
import { bankCandidates, bankFiles, bankFree, bankModelFolder, bankState, bytesWords, shortFolder, verifyBank } from './bank.js'
import { parseBankSums } from './boxBank.js'
import { shQuote } from './boxExecution.js'
import type { HostRecipe } from './recipes.js'
import { hostDirectory } from './store.js'
import { sshArguments, type HostRunner, type SshTarget } from './ssh.js'
import { volumeModel } from './volumes.js'

const preferenceSchema = z.object({ folder: z.string(), bytesPerSecond: z.number().positive(), measuredAt: z.string(), source: z.enum(['reported', 'transfer']) })
const preferencesSchema = z.record(z.string(), preferenceSchema)
type UploadPreference = z.infer<typeof preferenceSchema>
const preferencesPath = (): string => join(hostDirectory(), 'bank-uploads.json')
function preferences(): Record<string, UploadPreference> {
  try { return preferencesSchema.parse(JSON.parse(readFileSync(preferencesPath(), 'utf8'))) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
export const bankUploadPreference = (recipe: HostRecipe): UploadPreference | undefined => preferences()[volumeModel(recipe)]
export function rememberBankUpload(recipe: HostRecipe, preference: UploadPreference | undefined): void {
  const rows = preferences()
  if (preference) rows[volumeModel(recipe)] = preferenceSchema.parse(preference)
  else delete rows[volumeModel(recipe)]
  publishAtomicSync(preferencesPath(), JSON.stringify(rows) + '\n', { mode: 0o600 })
}
const minutes = (seconds: number): string => seconds < 60 ? 'under a minute' : seconds < 3600 ? '~' + Math.ceil(seconds / 60) + ' min' : '~' + (seconds / 3600).toFixed(1) + ' hours'
function bankCopyEstimate(bytes: number): string {
  const fast = minutes(bytes * 3 / 500e6), slow = minutes(bytes * 3 / 100e6)
  return (fast === slow ? fast : fast + '–' + slow) + ' including full checks, assuming 100–500 MB/s on both drives'
}
export function bankUploadEstimate(recipe: HostRecipe): string {
  const preference = bankUploadPreference(recipe)
  return preference ? minutes(recipe.weightsGb * 1e9 / preference.bytesPerSecond) + ' at ' + (preference.bytesPerSecond * 8 / 1e6).toFixed(1) + ' Mbps (' + (preference.source === 'transfer' ? 'last transfer' : 'your measured upload speed') + ', ' + preference.measuredAt.slice(0, 10) + '); verification and engine loading are additional' : 'upload time not measured yet'
}
export function bankUploadBudget(recipe: HostRecipe | undefined): number {
  if (!recipe) return 0
  const preference = bankUploadPreference(recipe)
  return preference ? Math.ceil(recipe.weightsGb * 1e9 / preference.bytesPerSecond * 3000) + 600_000 : 0
}
async function bankSource(recipe: HostRecipe, folder: string, signal: AbortSignal): Promise<{ path: string; bytes: number; sums: Map<string, string>; text: string }> {
  const state = bankState(recipe, folder)
  if (!state.banked || !state.path) throw new Error('Bank this model before keeping another copy.')
  const path = realpathSync(state.path)
  const text = readFileSync(join(path, 'SHA256SUMS'), 'utf8')
  const sums = parseBankSums(text)
  const files = new Set([...sums.keys(), ...bankFiles(recipe, path).files.map(file => file.path)])
  for (const file of files) {
    let parent = path
    for (const part of file.split('/')) {
      parent = join(parent, part)
      if (lstatSync(parent).isSymbolicLink()) throw new Error('A bank transfer cannot follow a symbolic link: ' + file)
    }
    if (!lstatSync(parent).isFile()) throw new Error('Not a regular bank file: ' + file)
    if (!sums.has(file)) sums.set(file, await hash(parent, signal))
  }
  const bytes = [...sums.keys()].reduce((sum, file) => sum + lstatSync(join(path, file)).size, 0)
  return { path, bytes, sums, text: [...sums].map(([file, digest]) => digest + '  ' + file).join('\n') + '\n' }
}
async function hash(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const digest = createHash('sha256')
  const stream = createReadStream(path, { signal })
  for await (const data of stream) digest.update(data)
  return digest.digest('hex')
}
export async function copyBankToFolder(recipe: HostRecipe, folder: string, destinationFolder: string, signal: AbortSignal, progress: (words: string) => void = () => {}): Promise<string> {
  const source = await bankSource(recipe, folder, signal)
  mkdirSync(destinationFolder, { recursive: true })
  const destinationRoot = realpathSync(destinationFolder)
  const destination = bankModelFolder(destinationRoot, recipe)
  const inside = relative(source.path, destination)
  if (inside === '' || !inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside)) throw new Error('Choose another folder outside this model’s bank.')
  if (existsSync(destination)) throw new Error('That destination already holds this model. Nothing was overwritten; verify it from the Bank instead.')
  const free = bankFree(destinationRoot)
  if (free !== undefined && free < source.bytes) throw new Error('The destination needs ' + bytesWords(source.bytes) + ' free.')
  await verifyBank(recipe, folder, signal, progress)
  const partial = join(destinationRoot, '.mercury-copy-' + randomUUID())
  mkdirSync(partial)
  try {
    let copied = 0
    for (const [file, expected] of source.sums) {
      signal.throwIfAborted()
      const target = join(partial, file)
      mkdirSync(dirname(target), { recursive: true })
      progress('copying to the other drive · ' + bytesWords(copied) + ' of ' + bytesWords(source.bytes))
      await pipeline(createReadStream(join(source.path, file)), createWriteStream(target, { flags: 'wx' }), { signal })
      if (await hash(target, signal) !== expected) throw new Error('The copied file differs from SHA256SUMS: ' + file)
      copied += lstatSync(target).size
    }
    writeFileSync(join(partial, 'SHA256SUMS'), source.text, { flag: 'wx' })
    signal.throwIfAborted()
    if (existsSync(destination)) throw new Error('The destination appeared during copying. Nothing was overwritten.')
    renameSync(partial, destination)
    return destination
  } finally { rmSync(partial, { recursive: true, force: true }) }
}
export async function uploadBankForRental(recipe: HostRecipe, vendor: string, target: SshTarget, runner: HostRunner, signal: AbortSignal, progress: (words: string) => void = () => {}): Promise<string | undefined> {
  if (vendor !== 'vast' && vendor !== 'lambda') return
  const preference = bankUploadPreference(recipe)
  if (!preference) return
  const source = await bankSource(recipe, preference.folder, signal)
  await verifyBank(recipe, preference.folder, signal, progress)
  const remote = '/workspace/mercury-host/' + recipe.id + '/bank-weights'
  const args = sshArguments(target)
  await runner.run('ssh', [...args, 'mkdir -p ' + shQuote(remote)], signal)
  const temporary = mkdtempSync(join(hostDirectory(), 'bank-transfer-'))
  const list = join(temporary, 'files')
  writeFileSync(list, [...source.sums.keys()].join('\n') + '\n', { mode: 0o600 })
  const transport = ['ssh', ...args.slice(0, -1)].map(shQuote).join(' ')
  const at = Date.now()
  const mark = (): void => progress('uploading your bank to the rented machine · ' + bytesWords(source.bytes) + ' · ' + Math.floor((Date.now() - at) / 60_000) + ' min elapsed · ' + bankUploadEstimate(recipe))
  mark()
  const timer = setInterval(() => { if (!signal.aborted) try { mark() } catch {} }, 30_000)
  try {
    await runner.run('rsync', ['-a', '--files-from=' + list, '-e', transport, '--', source.path + '/', (target.user ? target.user + '@' : '') + target.host + ':' + remote + '/'], signal, Math.max(12 * 3600_000, bankUploadBudget(recipe)))
    const elapsed = Math.max(1, Date.now() - at)
    progress('verifying the uploaded bank on the rented machine')
    await runner.run('ssh', [...args, 'printf %s ' + shQuote(source.text) + ' > ' + shQuote(remote + '/SHA256SUMS') + ' && cd ' + shQuote(remote) + ' && sha256sum -c SHA256SUMS'], signal, Math.max(12 * 3600_000, bankUploadBudget(recipe)))
    rememberBankUpload(recipe, { ...preference, bytesPerSecond: source.bytes * 1000 / elapsed, source: 'transfer', measuredAt: new Date().toISOString() })
    return remote
  } finally { clearInterval(timer); rmSync(temporary, { recursive: true, force: true }) }
}
export async function keepSafeDoor(recipe: HostRecipe, folder: string, ask: Parameters<LlmHostRoad>[0], emit: Parameters<LlmHostRoad>[1], signal: AbortSignal, mirror: () => Promise<LlmHostResult | undefined>): Promise<LlmHostResult | undefined> {
  const state = bankState(recipe, folder)
  if (!state.banked) { emit({ title: 'Keep safe', words: 'Bank this model first; no copy was made.' }); return }
  const preference = bankUploadPreference(recipe)
  const choice = await ask({ step: 'bank-keep-safe', title: 'Keep safe · ' + recipe.label.split(' · ')[0], found: bytesWords(state.bytes) + ' banked on ' + shortFolder(folder), willRun: 'Choose another copy or how to use your bank. Nothing is rented here.', rows: [{ value: 'copy', label: 'Copy to another drive · verify every file · ' + bankCopyEstimate(state.bytes) }, { value: 'mirror', label: 'Mirror to a Runpod volume · price and preparation time before confirmation' }, { value: 'upload', label: 'Upload on first boot · Vast.ai / Lambda · slow on a home connection · ' + bankUploadEstimate(recipe) }, ...(preference ? [{ value: 'disable', label: 'Use Hugging Face downloads for future rentals instead' }] : []), { value: 'back', label: 'Back' }] })
  if (signal.aborted) return
  if (choice === 'mirror') return mirror()
  if (choice === 'disable') { rememberBankUpload(recipe, undefined); emit({ title: 'Keep safe', words: 'Future rentals download from Hugging Face. Your bank is untouched.' }); return }
  if (choice === 'copy') {
    const candidates = bankCandidates().filter(path => resolve(path) !== resolve(folder))
    const chosen = await ask({ step: 'bank-copy-folder', title: 'Copy to which drive?', found: 'Your current bank is kept. Choose a different mounted drive for protection from a drive failure.', willRun: bankCopyEstimate(state.bytes), rows: [...candidates.map(path => ({ value: path, label: shortFolder(path) })), { value: 'back', label: 'Back' }] })
    if (!chosen || !candidates.includes(chosen) || signal.aborted) return
    const confirm = await ask({ step: 'bank-copy-confirm', title: 'Confirm bank copy', found: bytesWords(state.bytes) + ' → ' + shortFolder(chosen), willRun: bankCopyEstimate(state.bytes) + '. Existing files are never overwritten.', rows: [{ value: 'copy', label: 'Copy and verify' }, { value: 'cancel', label: 'Cancel' }] })
    if (confirm !== 'copy' || signal.aborted) return
    const destination = await copyBankToFolder(recipe, folder, chosen, signal, words => emit({ title: 'Keep safe', words }))
    emit({ title: 'Keep safe', words: 'Copied and verified every file on ' + shortFolder(destination) + '. The original bank is untouched.' })
    return
  }
  if (choice !== 'upload') return
  const speed = await ask({ step: 'bank-upload-speed', title: 'Measured upload speed (Mbps)', found: 'Use the upload result from your connection’s speed test, not its download speed. This is slow for large models.', willRun: 'The rented machine bills while your bank uploads. Nothing is rented now.', initial: preference ? String(preference.bytesPerSecond * 8 / 1e6) : undefined })
  if (speed === null || signal.aborted) return
  const mbps = Number(speed)
  if (!Number.isFinite(mbps) || mbps <= 0) { emit({ title: 'Keep safe', words: 'Enter a positive measured upload speed in Mbps. No upload preference was saved.' }); return }
  const confirm = await ask({ step: 'bank-upload-confirm', title: 'Upload this bank on first boot?', found: bytesWords(state.bytes) + ' · ' + minutes(state.bytes * 8 / (mbps * 1e6)) + ' at your measured ' + mbps + ' Mbps; verification and engine loading are additional.', willRun: 'Applies to future Vast.ai and Lambda rentals of this model. The machine bills throughout the upload; keep this computer and drive connected. This does not keep a second copy after the rental is deleted.', rows: [{ value: 'upload', label: 'Use my bank on first boot' }, { value: 'cancel', label: 'Cancel' }] })
  if (confirm !== 'upload' || signal.aborted) return
  rememberBankUpload(recipe, { folder, bytesPerSecond: mbps * 1e6 / 8, measuredAt: new Date().toISOString(), source: 'reported' })
  emit({ title: 'Keep safe', words: 'Future Vast.ai and Lambda rentals upload from your bank on first boot · ' + bankUploadEstimate(recipe) + '. Nothing was rented.' })
}
