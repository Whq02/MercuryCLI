import manifests from '../../../assets/host/weights.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import type { HostRecipe } from './recipes.js'
import type { HostRecord } from './store.js'
import { patchHostRecord, removeHostRecord } from './store.js'
import { readKeptVolume, writeKeptVolume } from './volumes.js'
import { sshArguments, type HostRunner, type SshTarget } from './ssh.js'
import type { RunpodClient } from './runpod.js'

export interface WeightManifest { model: string; include: string; revision: string; files: { path: string; size: number; sha256?: string; git?: string }[] }
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
export const keptWeightsPath = (recipe: HostRecipe): string => '/workspace/mercury-weights/' + createHash('sha256').update(recipe.model + '\n' + (recipe.include ?? '')).digest('hex').slice(0, 24)
export function weightManifest(recipe: HostRecipe): WeightManifest {
  const row = manifests.find(row => row.model === recipe.model && row.include === (recipe.include ?? ''))
  if (!row || row.files.reduce((sum, file) => sum + file.size, 0) !== Math.round(recipe.weightsGb * 1e9)) throw new Error('No pinned weight manifest matches this recipe; fast-load cannot trust its files.')
  return row
}
export function weightCheckScript(manifest: WeightManifest, directory: string, download: boolean, options: { fully?: boolean; sampleManifestSha256?: string; progressPath?: string } = {}): string {
  return `import hashlib, json, pathlib, os, random
m = json.loads(${JSON.stringify(JSON.stringify(manifest))})
root = pathlib.Path(${JSON.stringify(directory)})
root.mkdir(parents=True, exist_ok=True)
expected_sample = ${JSON.stringify(options.sampleManifestSha256 ?? '')}
progress_path = ${JSON.stringify(options.progressPath ?? '')}
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
def sample(f):
    p = valid_path(f)
    if p is None:
        return None
    before = p.stat()
    size = before.st_size
    regions = [(0, size)] if size <= 2 * head_tail else [(0, head_tail), (size - head_tail, head_tail)]
    rng = random.Random(str(seed) + ':' + f['path'])
    if size > 2 * head_tail:
        regions += [(rng.randint(0, size - sample_block), sample_block) for _ in range(sample_count)]
    digest = hashlib.sha256()
    with p.open('rb') as stream:
        for offset, count in regions:
            stream.seek(offset)
            digest.update(str(offset).encode() + b':' + str(count).encode() + b':')
            digest.update(stream.read(count))
    after = p.stat()
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        return None
    return {'path': f['path'], 'size': size, 'mtimeNs': str(after.st_mtime_ns), 'sampleSha256': digest.hexdigest()}
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
        if saved['samples'] != [sample(f) for f in m['files']] or any(f is None for f in saved['samples']):
            return None
        return saved['sha256'], expected_sample
    except (OSError, ValueError, KeyError, TypeError):
        return None
def full_check():
    progress('full check running ~' + str(max(1, round(sum(f['size'] for f in m['files']) / 18000000000))) + ' min')
    sums = []
    sizes = []
    samples = []
    for index, f in enumerate(m['files']):
        progress('full check running ~' + str(max(1, round(sum(row['size'] for row in m['files']) / 18000000000))) + ' min · file ' + str(index + 1) + '/' + str(len(m['files'])))
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
        sampled = sample(f)
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
verified = None if ${options.fully || download ? 'True' : 'False'} else sampled_check()
check = 'sampled' if verified else 'full'
if ${download ? 'True' : 'False'}:
    progress('downloading weights to kept disk')
    from huggingface_hub import snapshot_download
    snapshot_download(repo_id=m['model'], revision=m['revision'], allow_patterns=[f['path'] for f in m['files']], local_dir=str(root), force_download=True)
if verified is None:
    verified = full_check()
if verified is None:
    raise RuntimeError('Kept weights failed pinned SHA256/sizes verification')
progress('weights kept · ' + ('sampled check passed' if check == 'sampled' else 'full check passed'))
print('MERCURY_WEIGHTS ' + json.dumps({'sha256': verified[0], 'sampleManifestSha256': verified[1], 'files': len(m['files']), 'bytes': sum(f['size'] for f in m['files']), 'skipped': ${download ? 'False' : 'True'}, 'check': check}))
`
}
export async function prepareKeptWeights(record: HostRecord, recipe: HostRecipe, api: RunpodClient, target: SshTarget, runner: HostRunner, signal: AbortSignal, mark: (step: string) => void): Promise<string> {
  const volume = record.volumeId && readKeptVolume(record.volumeId)
  if (!volume || volume.state === 'gone' || volume.state === 'creating') throw new Error('The kept weights disk is not available; open Fast-load before resuming.')
  const manifest = weightManifest(recipe)
  const directory = keptWeightsPath(recipe)
  const progressPath = '/workspace/mercury-host/' + recipe.id + '/weights-check.log'
  let failure: unknown
  try {
    patchHostRecord(record.id, { weightsCheck: undefined })
    mark(record.verifyWeightsFully ? 'full check running ~' + Math.max(1, Math.round(recipe.weightsGb / 18)) + ' min' : 'checking kept weight samples')
    const setup = 'if ! command -v python3 >/dev/null; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv; fi; '
    let output: string
    try {
      output = await runner.run('ssh', [...sshArguments(target), setup + 'python3 -c ' + quote(weightCheckScript(manifest, directory, false, { fully: record.verifyWeightsFully, sampleManifestSha256: volume.verifiedSums?.sampleManifestSha256, progressPath }))], signal, 90 * 60_000)
    } catch (error) {
      signal.throwIfAborted()
      mark('downloading weights to kept disk')
      writeKeptVolume({ ...volume, state: 'preparing', verifiedSums: undefined, error: undefined, preparingPod: record.id })
      const install = 'set -e; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv; python3 -m venv /workspace/mercury-weights-hf; /workspace/mercury-weights-hf/bin/pip install --upgrade huggingface_hub; '
      output = await runner.run('ssh', [...sshArguments(target), install + '/workspace/mercury-weights-hf/bin/python -c ' + quote(weightCheckScript(manifest, directory, true, { progressPath }))], signal, 90 * 60_000)
    }
    const line = output.split('\n').findLast(line => line.startsWith('MERCURY_WEIGHTS '))
    if (!line) throw new Error('No verified weight receipt returned from the pod.')
    const verified = JSON.parse(line.slice('MERCURY_WEIGHTS '.length)) as { sha256: string; sampleManifestSha256: string; files: number; bytes: number; skipped: boolean; check: 'sampled' | 'full' }
    if (!/^[a-f0-9]{64}$/.test(verified.sha256) || !/^[a-f0-9]{64}$/.test(verified.sampleManifestSha256) || !['sampled', 'full'].includes(verified.check) || verified.files !== manifest.files.length || verified.bytes !== manifest.files.reduce((n, file) => n + file.size, 0)) throw new Error('The weight receipt does not match the pinned manifest.')
    writeKeptVolume({ ...volume, state: 'kept', filledBy: verified.skipped ? volume.filledBy : record.id, checkedBy: record.id, preparingPod: undefined, verifiedSums: { sha256: verified.sha256, sampleManifestSha256: verified.sampleManifestSha256, check: verified.check, files: verified.files, bytes: verified.bytes, at: new Date().toISOString() }, error: undefined })
    const status = 'weights kept · ' + (verified.check === 'sampled' ? 'sampled check passed' : 'full check passed')
    patchHostRecord(record.id, { weightsCheck: status, verifyWeightsFully: false })
    mark(status)
    return directory
  } catch (error) {
    failure = error
    writeKeptVolume({ ...volume, state: 'failed', verifiedSums: undefined, preparingPod: record.id, error: String(error) })
    throw error
  } finally {
    if (record.prepareWeightsOnly) {
      try {
        await api.terminate(record.id)
        if ((await api.pods()).some(row => row.id === record.id)) throw new Error('The preparation pod is still listed and may still bill.')
        removeHostRecord(record.id)
      } catch (error) {
        patchHostRecord(record.id, { jobState: 'failed', error: (failure ? String(failure) + ' · ' : '') + 'Preparation pod cleanup failed: ' + String(error), prepareWeightsOnly: true })
        throw new Error('Preparation pod ' + record.id + ' may still bill. Pods I’m paying for → Terminate. ' + String(error))
      }
    }
  }
}
