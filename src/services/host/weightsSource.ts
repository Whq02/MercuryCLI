import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { LlmHostRoad } from '../llmHost/index.js'
import { hostSetupEstimate } from '../../commands/llmhost/words.js'
import { bankState, bootMinutes, bytesWords, shortFolder, sizeWords } from './bank.js'
import { shQuote } from './boxExecution.js'
import { downloadFailure, downloadWatchScript, keptDownloadMinutes, keptRunMs } from './download.js'
import { fetchHuggingFaceRepo, huggingFaceHubBase, huggingFaceToken } from './hfRecipes.js'
import { bankUploadEstimate, bankUploadPreference } from './keepSafe.js'
import { resolvedWeightManifest } from './keptWeights.js'
import type { HostRecipe } from './recipes.js'
import type { HostOffer } from './runpod.js'
import { sshArguments, type HostRunner, type SshTarget } from './ssh.js'
import { hostDirectory } from './store.js'
import { keptDiskPrice, readKeptVolume, vastVolumeBilling, type KeptVolume } from './volumes.js'
import { vastBootMinutes } from './vastVolumes.js'
import { vendorLabel, type HostVendorId } from './vendors/client.js'

type Ask = Parameters<LlmHostRoad>[0]
type Emit = Parameters<LlmHostRoad>[1]
export type WeightsSource =
  | { kind: 'huggingface' }
  | { kind: 'private-repo'; repo: string; patterns?: string[]; bytes?: number; files?: number }
  | { kind: 'bank'; folder: string }
  | { kind: 'volume'; volumeId: string }
type WeightsSourceKind = WeightsSource['kind']
export interface WeightsSourceContext {
  recipe: HostRecipe
  vendor: HostVendorId
  managed: boolean
  offer?: HostOffer
  volume?: KeptVolume
  volumeReason?: string
  token?: string
  hubBase?: string
  remembered?: string
}
interface WeightsSourceChoice { value: WeightsSourceKind; label: string; source?: WeightsSource; reason?: string }
const WEIGHTS_SOURCE_STEP = 'weights-source'
const WEIGHTS_PRIVATE_REPO_STEP = 'weights-private-repo'
export const WEIGHTS_SOURCE_ROW = 'weights-source'
const modelTitle = (recipe: HostRecipe): string => recipe.label.split(' · ')[0]!
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const ggufShards = (weightFile: string): string[] => {
  const parts = /-00001-of-(\d+)\.gguf$/.exec(weightFile)
  return parts ? Array.from({ length: Number(parts[1]) }, (_, index) => weightFile.replace('-00001-of-', '-' + String(index + 1).padStart(5, '0') + '-of-')) : [weightFile]
}
function neededFiles(recipe: HostRecipe): { paths: { path: string; size?: number; sha256?: string }[]; patterns?: string[]; words: string } {
  const manifest = resolvedWeightManifest(recipe)?.manifest
  if (manifest) return { paths: manifest.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })), patterns: manifest.files.map(file => file.path), words: 'the pinned manifest’s ' + manifest.files.length + (manifest.files.length === 1 ? ' file, ' : ' files, ') + sizeWords(manifest.files.reduce((sum, file) => sum + file.size, 0) / 1e9) }
  if (recipe.weightFile) {
    const paths = [...ggufShards(recipe.weightFile), ...(recipe.mmproj ? [recipe.mmproj] : [])].map(path => ({ path }))
    const include = recipe.include ?? (posix.dirname(recipe.weightFile) === '.' ? '*.gguf' : posix.dirname(recipe.weightFile) + '/*')
    return { paths, patterns: [include, ...(recipe.mmproj ? [recipe.mmproj] : [])], words: paths.map(file => posix.basename(file.path)).join(', ') }
  }
  return { paths: [{ path: 'config.json' }], words: 'config.json and the safetensors shards' }
}
export const weightsSourceDefault = (context: Pick<WeightsSourceContext, 'recipe' | 'vendor' | 'volume' | 'managed'>): WeightsSource => context.volume ? { kind: 'volume', volumeId: context.volume.id } : !context.managed && (context.vendor === 'vast' || context.vendor === 'lambda') && bankUploadPreference(context.recipe) ? { kind: 'bank', folder: bankUploadPreference(context.recipe)!.folder } : { kind: 'huggingface' }
export function weightsSourceWords(source: WeightsSource, recipe: HostRecipe, volume = source.kind === 'volume' ? readKeptVolume(source.volumeId) : undefined): string {
  if (source.kind === 'huggingface') return 'Hugging Face · ' + sizeWords(recipe.weightsGb) + ' · ~' + bootMinutes(recipe) + ' min'
  if (source.kind === 'private-repo') return source.repo + (source.bytes ? ' · ' + sizeWords(source.bytes / 1e9) : '') + ' · private'
  if (source.kind === 'bank') return 'Bank · ' + shortFolder(source.folder) + ' · upload ' + bankUploadEstimate(recipe)
  if (!volume) return 'volume ' + source.volumeId
  if (volume.kind === 'vast') return 'Vast.ai volume ' + volume.id + ' · machine ' + volume.machineId + (volume.state === 'kept' ? ' · ~' + vastBootMinutes(recipe, volume) + ' min' : ' · downloads first') + ' · ' + vastVolumeBilling(volume)
  return 'weights disk ' + volume.id + ' · ' + volume.dataCenter + (volume.state === 'kept' ? ' · ~' + bootMinutes(recipe, volume) + ' min' : ' · downloads first') + ' · ' + keptDiskPrice(volume)
}
function weightsSourceChoices(context: WeightsSourceContext): WeightsSourceChoice[] {
  const { recipe, vendor, managed } = context
  const token = context.token ?? huggingFaceToken()
  const unavailable = (value: WeightsSourceKind, label: string, reason: string): WeightsSourceChoice => ({ value, label: label + ' · unavailable · ' + reason, reason })
  const huggingface: WeightsSourceChoice = { value: 'huggingface', source: { kind: 'huggingface' }, label: 'Hugging Face · ' + recipe.model + ' · ' + sizeWords(recipe.weightsGb) }
  const privateRepo: WeightsSourceChoice = managed ? unavailable('private-repo', 'Private repository', 'use the endpoint’s repository')
    : !token ? unavailable('private-repo', 'Private repository', '/logins huggingface')
    : { value: 'private-repo', label: 'Private repository' + (context.remembered ? ' · ' + context.remembered : '') }
  const state = bankState(recipe)
  const bank: WeightsSourceChoice = managed ? unavailable('bank', 'This computer’s Bank', 'no SSH on HF endpoints')
    : !state.banked ? unavailable('bank', 'This computer’s Bank', 'bank this model first · b in Bank')
    : state.error ? unavailable('bank', 'This computer’s Bank', 'check failed · v in Bank')
    : { value: 'bank', source: { kind: 'bank', folder: state.folder! }, label: 'This computer’s Bank · ' + bytesWords(state.bytes) + ' · upload ' + bankUploadEstimate(recipe) }
  const volume: WeightsSourceChoice = managed ? unavailable('volume', 'Kept volume', 'not supported by HF endpoints')
    : vendor === 'lambda' ? unavailable('volume', 'Kept volume', 'not supported by ' + vendorLabel(vendor))
    : !context.volume ? unavailable('volume', 'Kept volume', context.volumeReason ?? 'mirror this model first · m in Bank')
    : { value: 'volume', source: { kind: 'volume', volumeId: context.volume.id }, label: 'Kept volume · ' + weightsSourceWords({ kind: 'volume', volumeId: context.volume.id }, recipe, context.volume) }
  return [huggingface, privateRepo, bank, volume]
}
async function readPrivateRepo(context: Pick<WeightsSourceContext, 'recipe' | 'token' | 'hubBase'>, repo: string, signal: AbortSignal): Promise<{ ok: true; source: WeightsSource & { kind: 'private-repo' } } | { ok: false; words: string }> {
  if (!REPO_PATTERN.test(repo)) return { ok: false, words: 'Give the repository as namespace/name.' }
  const token = context.token ?? huggingFaceToken()
  if (!token) return { ok: false, words: 'No Hugging Face sign-in · /logins huggingface' }
  const read = await fetchHuggingFaceRepo(repo, { token, base: context.hubBase ?? huggingFaceHubBase(), signal })
  if (!read.ok) return { ok: false, words: repo + ' · ' + read.words }
  const needed = neededFiles(context.recipe)
  const listed = new Map(read.files.map(file => [file.path, file]))
  for (const file of needed.paths) {
    const found = listed.get(file.path)
    if (!found) return { ok: false, words: repo + ' does not hold ' + file.path + ' · this recipe needs ' + needed.words }
    if (file.size !== undefined && found.size !== file.size) return { ok: false, words: repo + ' · ' + file.path + ' is ' + bytesWords(found.size) + ', the pinned manifest says ' + bytesWords(file.size) + ' · not the same copy' }
    if (file.sha256 && found.sha256 && found.sha256 !== file.sha256) return { ok: false, words: repo + ' · ' + file.path + ' hash differs from the pinned manifest · not the same copy' }
  }
  const safetensors = read.files.filter(file => /\.safetensors$/i.test(file.path))
  if (!context.recipe.weightFile && !needed.patterns && !safetensors.length) return { ok: false, words: repo + ' holds no safetensors shards · this recipe needs ' + needed.words }
  const matched = needed.patterns ? needed.paths.map(file => listed.get(file.path)!) : read.files.filter(file => /\.(safetensors|json|jinja|txt|model|py)$/i.test(file.path))
  const bytes = matched.reduce((sum, file) => sum + file.size, 0)
  return { ok: true, source: { kind: 'private-repo', repo, ...(needed.patterns ? { patterns: needed.patterns } : {}), bytes, files: matched.length } }
}
export async function chooseWeightsSource(context: WeightsSourceContext, current: WeightsSource | undefined, ask: Ask, emit: Emit, signal: AbortSignal): Promise<WeightsSource | undefined> {
  const { recipe } = context
  for (;;) {
    const choices = weightsSourceChoices(context)
    const choice = await ask({ step: WEIGHTS_SOURCE_STEP, title: 'Weights · ' + modelTitle(recipe), found: '', willRun: '', initial: current?.kind ?? weightsSourceDefault(context).kind, rows: [...choices.map(row => ({ value: row.value, label: row.label })), { value: 'back', label: 'Back' }] })
    if (!choice || choice === 'back' || signal.aborted) return
    const picked = choices.find(row => row.value === choice)
    if (!picked) continue
    if (picked.reason) { emit({ title: 'Weights', words: picked.label.split(' · unavailable · ')[0] + ' cannot be used: ' + picked.reason + ' · nothing was rented' }); continue }
    if (picked.value !== 'private-repo') return picked.source
    const needed = neededFiles(recipe)
    const entered = await ask({ step: WEIGHTS_PRIVATE_REPO_STEP, title: 'Private Hugging Face repository', found: 'namespace/name · needs ' + needed.words, willRun: 'The machine downloads with your Hugging Face sign-in. Nothing is uploaded.', initial: context.remembered })
    if (entered === null || signal.aborted) continue
    const read = await readPrivateRepo(context, entered.trim(), signal)
    if (signal.aborted) return
    if (!read.ok) { emit({ title: 'Weights', words: read.words + ' · nothing was rented' }); continue }
    return read.source
  }
}
const imagePath = 'if test -r /proc/1/environ; then image_path="$(tr \'\\0\' \'\\n\' < /proc/1/environ | sed -n \'s/^PATH=//p\')"; if test -n "$image_path"; then export PATH="$image_path:$PATH"; fi; fi\n'
function privateRepoDownloadScript(source: WeightsSource & { kind: 'private-repo' }, recipe: HostRecipe, directory: string, tokenPath: string): string {
  const bytes = source.bytes || recipe.weightsGb * 1e9
  return `import json, os, pathlib, sys, threading, time
from huggingface_hub import snapshot_download
root = pathlib.Path(${JSON.stringify(directory)})
root.mkdir(parents=True, exist_ok=True)
token_path = pathlib.Path(${JSON.stringify(tokenPath)})
token = token_path.read_text().strip()
token_path.unlink()
def progress(text):
    print('MERCURY_STEP ' + text, flush=True)
${downloadWatchScript(bytes, { deadlineSeconds: keptDownloadMinutes(recipe) * 60 })}
threading.Thread(target=watch_download, daemon=True).start()
try:
    snapshot_download(repo_id=${JSON.stringify(source.repo)}, allow_patterns=${source.patterns ? JSON.stringify(source.patterns) : 'None'}, local_dir=str(root), token=token)
except BaseException:
    with gate:
        done.set()
    partial()
    raise
with gate:
    done.set()
print('MERCURY_PRIVATE_WEIGHTS ' + json.dumps({'repo': ${JSON.stringify(source.repo)}}), flush=True)
`
}
export function privateRepoDownloadCommand(source: WeightsSource & { kind: 'private-repo' }, recipe: HostRecipe, directory: string, tokenPath: string, execution: { docker: boolean; pod: boolean }): string {
  const venv = '/workspace/mercury-weights-hf'
  const python = 'if python3 -c ' + shQuote('import huggingface_hub') + ' >/dev/null 2>&1; then py=python3; else py=' + shQuote(venv + '/bin/python') + '; if ! test -x "$py"; then if ! python3 -m venv ' + shQuote(venv) + '; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv && python3 -m venv ' + shQuote(venv) + '; fi; fi; ' + shQuote(venv + '/bin/pip') + ' install --upgrade huggingface_hub; fi\n'
  const script = 'set -e\n' + (execution.pod ? imagePath : '') + python + '"$py" -c ' + shQuote(privateRepoDownloadScript(source, recipe, directory, tokenPath)) + '\n'
  return execution.docker && !execution.pod ? 'docker run --rm -v /workspace:/workspace -e HF_HOME=/workspace/huggingface --entrypoint bash ' + shQuote(recipe.image) + ' -c ' + shQuote(script) : script
}
const TOKEN_CLEANUP_MS = 60_000
export const TOKEN_REVOKE_WORDS = 'revoke the token at https://huggingface.co/settings/tokens if the machine is kept'
export async function downloadPrivateRepoForRental(source: WeightsSource & { kind: 'private-repo' }, recipe: HostRecipe, token: string, target: SshTarget, runner: HostRunner, signal: AbortSignal, mark: (step: string) => void, execution: { docker: boolean; pod: boolean }): Promise<string> {
  const base = '/workspace/mercury-host/' + recipe.id
  const directory = base + '/private-weights'
  const tokenPath = base + '/hf-token'
  const args = sshArguments(target)
  const plain = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split(token).join('[redacted]').replace(/\s+/g, ' ').trim().slice(0, 240)
  const unconfirmed = (error: unknown): string => 'the Hugging Face sign-in file ' + tokenPath + ' could not be confirmed removed from the machine (' + plain(error) + ') · ' + TOKEN_REVOKE_WORDS
  const removeToken = async (): Promise<unknown> => {
    try { await runner.run('ssh', [...args, 'rm -f ' + shQuote(tokenPath) + ' && test ! -e ' + shQuote(tokenPath)], AbortSignal.timeout(TOKEN_CLEANUP_MS), TOKEN_CLEANUP_MS); return undefined } catch (error) { return error ?? new Error('cleanup failed') }
  }
  mark('placing your Hugging Face sign-in on the machine')
  await runner.run('ssh', [...args, 'mkdir -p ' + shQuote(base) + ' && chmod 700 ' + shQuote(base)], signal)
  let output = ''
  let failure: unknown
  try {
    const temporary = mkdtempSync(join(hostDirectory(), 'hf-token-'))
    try {
      const local = join(temporary, 'token')
      writeFileSync(local, token, { mode: 0o600 })
      const transport = ['ssh', ...args.slice(0, -1)].map(shQuote).join(' ')
      await runner.run('rsync', ['-a', '-e', transport, '--', local, (target.user ? target.user + '@' : '') + target.host + ':' + tokenPath], signal)
    } finally { rmSync(temporary, { recursive: true, force: true }) }
    mark('downloading from ' + source.repo + ' · ' + (source.bytes ? bytesWords(source.bytes) : sizeWords(recipe.weightsGb)) + ' · ' + hostSetupEstimate({ ...recipe, weightsGb: source.bytes ? source.bytes / 1e9 : recipe.weightsGb }).split(' · ').find(part => part.startsWith('downloads')))
    try {
      output = await runner.run('ssh', [...args, privateRepoDownloadCommand(source, recipe, directory, tokenPath, execution)], signal, keptRunMs(recipe))
    } catch (error) {
      if (signal.aborted) throw error
      throw new Error(downloadFailure(error, { ...recipe, weightsGb: source.bytes ? source.bytes / 1e9 : recipe.weightsGb }).words + ' · from ' + source.repo)
    }
  } catch (error) {
    failure = error ?? new Error('private repository download failed')
  } finally {
    const cleanup = await removeToken()
    if (failure !== undefined) {
      if (cleanup === undefined) throw failure
      throw Object.assign(new Error(plain(failure) + ' · ' + unconfirmed(cleanup)), { cause: failure })
    }
    if (cleanup !== undefined) throw new Error('The download from ' + source.repo + ' finished, but ' + unconfirmed(cleanup) + ' · nothing was started on the machine')
  }
  if (!output.split('\n').some(line => line.startsWith('MERCURY_PRIVATE_WEIGHTS '))) throw new Error('The machine returned no download receipt for ' + source.repo + '.')
  mark('private repository downloaded · ' + source.repo + ' · sign-in file removed from the machine')
  return directory
}
