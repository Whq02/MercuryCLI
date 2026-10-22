import shippedManifests from '../../../assets/host/weights.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod/v4'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { HostRecipe } from './recipes.js'
import type { HostRecord } from './store.js'
import { patchHostRecord, removeHostRecord } from './store.js'
import { hostNotice } from './notices.js'
import { fullCheckMinutes, gigabytes, keptDiskPrice, readKeptVolume, volumePrice, writeKeptVolume } from './volumes.js'
import { sshArguments, type HostRunner, type SshTarget } from './ssh.js'
import { RunpodHttpError, type RunpodClient } from './runpod.js'
import { downloadFailure, downloadWatchScript, keptDownloadMinutes, keptRunMs, type DownloadWatchOptions } from './download.js'
export { keptDownloadMinutes, keptStallWords } from './download.js'
export class HostPreparationCleanupFailed extends Error {}
export interface WeightManifest { model: string; include: string; revision: string; files: { path: string; size: number; sha256?: string; git?: string }[] }
interface WeightScriptOptions extends DownloadWatchOptions { fully?: boolean; sampleManifestSha256?: string; progressPath?: string; fullWords?: string }
const manifestsSchema = z.array(z.object({ model: z.string(), include: z.string(), revision: z.string(), files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), git: z.string().regex(/^[a-f0-9]{40}$/).optional() })) }))
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const KEPT_MISMATCH = 'Kept weights failed pinned SHA256/sizes verification'
export const keptWeightsPath = (recipe: HostRecipe): string => '/workspace/mercury-weights/' + createHash('sha256').update(recipe.model + '\n' + (recipe.include ?? '')).digest('hex').slice(0, 24)
export function weightManifests(): WeightManifest[] {
  const localPath = flagEnv('MERCURY_HOST_WEIGHTS_FILE')?.trim()
  if (localPath) return manifestsSchema.parse(JSON.parse(readFileSync(resolve(localPath), 'utf8')))
  return shippedManifests
}
export function pinnedWeightManifest(recipe: HostRecipe): WeightManifest | undefined {
  const row = weightManifests().find(row => row.model === recipe.model && row.include === (recipe.include ?? ''))
  return row && row.files.reduce((sum, file) => sum + file.size, 0) === Math.round(recipe.weightsGb * 1e9) ? row : undefined
}
export function weightManifest(recipe: HostRecipe): WeightManifest {
  const row = pinnedWeightManifest(recipe)
  if (!row) throw new Error('No pinned weight manifest matches this recipe; fast-load cannot trust its files.')
  return row
}
export function weightCheckScript(manifest: WeightManifest, directory: string, download: boolean, options: WeightScriptOptions = {}): string {
  return `import hashlib, json, pathlib, os, random, threading, time
m = json.loads(${JSON.stringify(JSON.stringify(manifest))})
root = pathlib.Path(${JSON.stringify(directory)})
root.mkdir(parents=True, exist_ok=True)
expected_sample = ${JSON.stringify(options.sampleManifestSha256 ?? '')}
progress_path = ${JSON.stringify(options.progressPath ?? '')}
full_words = ${JSON.stringify(options.fullWords ?? fullCheckMinutes(manifest.files.reduce((sum, file) => sum + file.size, 0) / 1e9))}
head_tail = 64 * 1024 * 1024
sample_block = 1024 * 1024
sample_count = 8
seed = 40
identity = hashlib.sha256(json.dumps(m, sort_keys=True).encode()).hexdigest()
def progress(text):
    line = 'MERCURY_STEP ' + text + '\\n'
    print(line, end='', flush=True)
    if progress_path:
        p = pathlib.Path(progress_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open('a') as log:
            log.write(line)
def valid_path(f):
    p = root / f['path']
    if p.is_symlink() or not p.is_file() or not p.resolve().is_relative_to(root.resolve()) or p.stat().st_size != f['size']:
        return None
    return p
def regions_for(f):
    size = f['size']
    if size <= 2 * head_tail:
        return [[0, size]]
    rng = random.Random(str(seed) + ':' + f['path'])
    return [[0, head_tail], [size - head_tail, head_tail]] + [[rng.randint(0, size - sample_block), sample_block] for _ in range(sample_count)]
def regions_ok(f, regions):
    size = f['size']
    if not isinstance(regions, list) or any(not isinstance(r, list) or len(r) != 2 or not all(type(v) is int for v in r) or r[0] < 0 or r[1] < 0 or r[0] + r[1] > size for r in regions):
        return False
    if size <= 2 * head_tail:
        return regions == [[0, size]]
    return regions[:2] == [[0, head_tail], [size - head_tail, head_tail]] and len(regions) == 2 + sample_count and all(r[1] == sample_block for r in regions[2:])
def sample(f, regions):
    p = valid_path(f)
    if p is None or not regions_ok(f, regions):
        return None
    before = p.stat()
    digest = hashlib.sha256()
    with p.open('rb') as stream:
        for offset, count in regions:
            stream.seek(offset)
            digest.update(str(offset).encode() + b':' + str(count).encode() + b':')
            digest.update(stream.read(count))
    after = p.stat()
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        return None
    return {'path': f['path'], 'size': f['size'], 'mtimeNs': str(after.st_mtime_ns), 'regions': regions, 'sampleSha256': digest.hexdigest()}
def sampled_check():
    if not expected_sample:
        return None
    try:
        raw = (root / 'SAMPLES.json').read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected_sample:
            return None
        saved = json.loads(raw)
        if saved['identity'] != identity or saved['seed'] != seed or saved['headTailBytes'] != head_tail or saved['blockBytes'] != sample_block or saved['blocks'] != sample_count:
            return None
        if hashlib.sha256((root / 'SHA256SUMS').read_bytes()).hexdigest() != saved['sha256']:
            return None
        rows = saved['samples']
        if len(rows) != len(m['files']) or any(row['path'] != f['path'] or row['size'] != f['size'] for row, f in zip(rows, m['files'])):
            return None
        if rows != [sample(f, row['regions']) for row, f in zip(rows, m['files'])]:
            return None
        return saved['sha256'], expected_sample
    except (OSError, ValueError, KeyError, TypeError):
        return None
def full_check():
    progress('full check running ' + full_words)
    sums = []
    sizes = []
    samples = []
    for index, f in enumerate(m['files']):
        progress('full check running ' + full_words + ' · file ' + str(index + 1) + '/' + str(len(m['files'])))
        p = valid_path(f)
        if p is None:
            return None
        before = p.stat()
        sha = hashlib.sha256()
        git = hashlib.sha1(('blob ' + str(f['size']) + '\\0').encode())
        with p.open('rb') as stream:
            while block := stream.read(8 * 1024 * 1024):
                sha.update(block)
                if f.get('git'):
                    git.update(block)
        if f.get('sha256') and sha.hexdigest() != f['sha256'] or f.get('git') and git.hexdigest() != f['git']:
            return None
        sampled = sample(f, regions_for(f))
        if sampled is None or sampled['mtimeNs'] != str(before.st_mtime_ns):
            return None
        sums.append(sha.hexdigest() + '  ' + f['path'] + '\\n')
        sizes.append([f['path'], f['size']])
        samples.append(sampled)
    sums = ''.join(sums)
    digest = hashlib.sha256(sums.encode()).hexdigest()
    saved = json.dumps({'identity': identity, 'seed': seed, 'headTailBytes': head_tail, 'blockBytes': sample_block, 'blocks': sample_count, 'sha256': digest, 'samples': samples}, sort_keys=True)
    for name, data in [('SHA256SUMS', sums), ('SIZES.json', json.dumps(sizes)), ('SAMPLES.json', saved)]:
        temporary = root / (name + '.' + str(os.getpid()) + '.tmp')
        temporary.write_text(data)
        os.replace(temporary, root / name)
    return digest, hashlib.sha256(saved.encode()).hexdigest()
${downloadWatchScript(manifest.files.reduce((sum, file) => sum + file.size, 0), options)}
verified = None if ${options.fully || download ? 'True' : 'False'} else sampled_check()
check = 'sampled' if verified else 'full'
if ${download ? 'True' : 'False'}:
    progress('downloading weights to kept disk')
    from huggingface_hub import snapshot_download
    started = time.monotonic()
    threading.Thread(target=watch_download, daemon=True).start()
    try:
        snapshot_download(repo_id=m['model'], revision=m['revision'], allow_patterns=[f['path'] for f in m['files']], local_dir=str(root), force_download=True)
    except BaseException:
        with gate:
            done.set()
        partial()
        raise
    with gate:
        done.set()
if verified is None:
    verified = full_check()
if verified is None:
    if ${download ? 'True' : 'False'}:
        partial()
    raise RuntimeError(${JSON.stringify(KEPT_MISMATCH)})
progress('weights kept · ' + ('sampled check passed' if check == 'sampled' else 'full check passed'))
print('MERCURY_WEIGHTS ' + json.dumps({'sha256': verified[0], 'sampleManifestSha256': verified[1], 'files': len(m['files']), 'bytes': sum(f['size'] for f in m['files']), 'skipped': ${download ? 'False' : 'True'}, 'check': check}))
`
}
async function terminateVerified(api: RunpodClient, id: string): Promise<void> {
  try { await api.terminate(id) } catch (error) { if (!(error instanceof RunpodHttpError && error.status === 404)) throw error }
  if ((await api.pods()).some(row => row.id === id)) throw new Error('The preparation pod is still listed and may still bill.')
}
export async function prepareKeptWeights(record: HostRecord, recipe: HostRecipe, api: RunpodClient, target: SshTarget, runner: HostRunner, signal: AbortSignal, mark: (step: string) => void): Promise<string> {
  const volume = record.volumeId && readKeptVolume(record.volumeId)
  if (!volume || volume.state === 'gone' || volume.state === 'creating') throw new Error('The kept weights disk is not available; open Fast-load before resuming.')
  const manifest = weightManifest(recipe)
  const directory = keptWeightsPath(recipe)
  const progressPath = '/workspace/mercury-host/' + recipe.id + '/weights-check.log'
  let failure: unknown
  let downloading = false
  try {
    patchHostRecord(record.id, { weightsCheck: undefined })
    mark(record.verifyWeightsFully ? 'full check running ' + fullCheckMinutes(recipe.weightsGb) : 'checking kept weight samples')
    const setup = 'if ! command -v python3 >/dev/null; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv; fi; '
    let output: string
    try {
      output = await runner.run('ssh', [...sshArguments(target), setup + 'python3 -c ' + quote(weightCheckScript(manifest, directory, false, { fully: record.verifyWeightsFully, sampleManifestSha256: volume.verifiedSums?.sampleManifestSha256, progressPath }))], signal, keptRunMs(recipe))
    } catch (error) {
      signal.throwIfAborted()
      if (!String(error).includes(KEPT_MISMATCH)) throw error
      downloading = true
      mark('downloading weights to kept disk')
      writeKeptVolume({ ...volume, state: 'preparing', verifiedSums: undefined, error: undefined, partialBytes: undefined, preparingPod: record.id })
      const install = 'set -e; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv; python3 -m venv /workspace/mercury-weights-hf; /workspace/mercury-weights-hf/bin/pip install --upgrade huggingface_hub; '
      output = await runner.run('ssh', [...sshArguments(target), install + '/workspace/mercury-weights-hf/bin/python -c ' + quote(weightCheckScript(manifest, directory, true, { progressPath, deadlineSeconds: keptDownloadMinutes(recipe) * 60 }))], signal, keptRunMs(recipe))
    }
    const line = output.split('\n').findLast(line => line.startsWith('MERCURY_WEIGHTS '))
    if (!line) throw new Error('No verified weight receipt returned from the pod.')
    const verified = JSON.parse(line.slice('MERCURY_WEIGHTS '.length)) as { sha256: string; sampleManifestSha256: string; files: number; bytes: number; skipped: boolean; check: 'sampled' | 'full' }
    if (!/^[a-f0-9]{64}$/.test(verified.sha256) || !/^[a-f0-9]{64}$/.test(verified.sampleManifestSha256) || !['sampled', 'full'].includes(verified.check) || verified.files !== manifest.files.length || verified.bytes !== manifest.files.reduce((n, file) => n + file.size, 0)) throw new Error('The weight receipt does not match the pinned manifest.')
    writeKeptVolume({ ...volume, state: 'kept', filledBy: verified.skipped ? volume.filledBy : record.id, checkedBy: record.id, preparingPod: undefined, partialBytes: undefined, verifiedSums: { sha256: verified.sha256, sampleManifestSha256: verified.sampleManifestSha256, check: verified.check, files: verified.files, bytes: verified.bytes, at: new Date().toISOString() }, error: undefined })
    const status = 'weights kept · ' + (verified.check === 'sampled' ? 'sampled check passed' : 'full check passed')
    patchHostRecord(record.id, { weightsCheck: status, verifyWeightsFully: false })
    mark(status)
    return directory
  } catch (error) {
    failure = error
    const current = readKeptVolume(volume.id) ?? volume
    if (downloading || current.state !== 'kept') {
      const stop = downloading ? downloadFailure(error, recipe) : { words: 'Weights check did not finish: ' + String(error).split('\n')[0]!.slice(0, 240), bytes: undefined }
      const failed = { ...current, state: 'failed' as const, verifiedSums: undefined, preparingPod: record.id, partialBytes: stop.bytes, error: stop.words }
      writeKeptVolume(failed)
      failure = new Error(stop.words)
    }
    throw failure
  } finally {
    if (record.prepareWeightsOnly) {
      try {
        await terminateVerified(api, record.id)
        removeHostRecord(record.id)
      } catch (error) {
        const disk = readKeptVolume(volume.id) ?? volume
        const plain = (value: unknown): string => (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
        const words = (failure ? plain(failure) : 'Weights preparation finished') + ' · Mercury could not verify pod termination: ' + plain(error) + ' · check your account; pod ' + record.id + ' may still bill · weights disk ' + disk.id + ' is kept and bills ' + keptDiskPrice(disk) + ' · /llmhost → Pods I’m paying for → Terminate'
        patchHostRecord(record.id, { jobState: 'failed', error: words, prepareWeightsOnly: true })
        hostNotice(record, 'failed', recipe.label + ' · ' + words)
        throw new HostPreparationCleanupFailed(words)
      }
      const disk = readKeptVolume(volume.id)
      if (disk?.preparingPod === record.id) writeKeptVolume({ ...disk, preparingPod: undefined })
      if (disk && failure) hostNotice(record, 'failed', recipe.label + ' · preparation stopped: ' + (disk.error ?? String(failure)) + ' · temporary pod ' + record.id + ' terminated and verified absent (Runpod no longer lists it) · weights disk ' + disk.id + ' is kept ' + (disk.partialBytes === undefined ? '' : 'with ' + gigabytes(disk.partialBytes) + ' downloaded ') + 'and bills ' + keptDiskPrice(disk) + ' · /llmhost → Fast-load to delete it, or the next rental downloads again')
      else if (disk) hostNotice(record, 'prepared', recipe.label + ' · weights kept on ' + disk.id + ' (' + (disk.verifiedSums?.check ?? 'full') + ' check passed) · temporary pod ' + record.id + ' terminated (Runpod no longer lists it) · the disk bills ' + volumePrice(disk) + ' without a pod')
    }
  }
}
