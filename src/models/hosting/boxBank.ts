import type { HostBox } from './boxes.js'
import type { BoxRecipe } from './boxRecipes.js'
import { boxAbsolutePath, boxJoin, psQuote, runBoxScript, shQuote, writeBoxFile } from './boxExecution.js'
import type { HostRunner } from './ssh.js'

async function readBankText(box: HostBox, path: string, runner: HostRunner, signal: AbortSignal): Promise<string> {
  return runBoxScript(box, box.os === 'windows' ? 'Get-Content -LiteralPath ' + psQuote(path) + ' -Raw' : 'cat ' + shQuote(path), runner, signal)
}
export function parseBankSums(manifest: string): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const line of manifest.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line)
    if (!match) throw new Error('The bank needs a SHA256SUMS manifest containing hashes, not only a verification marker.')
    const file = match[2]!.replace(/^\.\//, '')
    if (file.startsWith('/') || file.includes('\\') || file.split('/').some(part => part === '..' || part === '') || /[\0\r\n:]/.test(file)) throw new Error('Unsafe path in bank checksums.')
    if (hashes.has(file)) throw new Error('Duplicate path in bank checksums.')
    hashes.set(file, match[1]!.toLowerCase())
  }
  return hashes
}
export async function verifyBoxBank(box: HostBox, recipe: BoxRecipe, destination: string, runner: HostRunner, signal: AbortSignal): Promise<void> {
  boxAbsolutePath(box, destination)
  let manifest = ''
  for (const name of ['SHA256SUMS', 'SHA256SUMS.txt', 'SHA256SUMS.manifest', 'SHA256SUMS.verified']) {
    try { manifest = await readBankText(box, boxJoin(box, destination, name), runner, signal); if (/^[a-f0-9]{64}\s/im.test(manifest)) break } catch { signal.throwIfAborted() }
  }
  const hashes = parseBankSums(manifest)
  let required = recipe.files ?? []
  if (recipe.engine === 'ollama') {
    const [model, tag = 'latest'] = recipe.model.split(':')
    const relative = 'manifests/registry.ollama.ai/library/' + model + '/' + tag
    const raw = JSON.parse(await readBankText(box, boxJoin(box, destination, relative), runner, signal)) as { config?: { digest: string }; layers?: { digest: string }[] }
    const digests = [raw.config, ...(raw.layers ?? [])].map(layer => layer?.digest)
    if (!digests.length || digests.some(digest => !/^sha256:[a-f0-9]{64}$/.test(digest ?? ''))) throw new Error('The bank has no complete Ollama model manifest.')
    required = [relative, ...digests.map(digest => 'blobs/' + digest!.replace(':', '-'))]
  }
  if (!required.length || required.some(file => !hashes.has(file))) throw new Error('SHA256SUMS does not cover every selected model file.')
  for (const file of required) {
    const expected = recipe.hashes?.[file] ?? (file.startsWith('blobs/sha256-') ? file.slice('blobs/sha256-'.length) : hashes.get(file)!)
    if (hashes.get(file) !== expected) throw new Error('Bank checksum differs from the documented model: ' + file)
    const path = boxJoin(box, destination, file)
    const script = box.os === 'windows' ? '(Get-FileHash -LiteralPath ' + psQuote(path) + ' -Algorithm SHA256).Hash' : (box.os === 'darwin' ? 'shasum -a 256 ' : 'sha256sum ') + shQuote(path)
    const actual = (await runBoxScript(box, script, runner, signal, 12 * 3600_000)).trim().split(/\s/)[0]?.toLowerCase()
    if (actual !== expected) throw new Error('Bank checksum failed: ' + file)
  }
}
export async function sealDownloadedBank(box: HostBox, recipe: BoxRecipe, destination: string, runner: HostRunner, signal: AbortSignal): Promise<void> {
  if (!recipe.files?.length) return
  const rows: string[] = []
  for (const file of recipe.files) {
    const path = boxJoin(box, destination, file)
    const hash = (await runBoxScript(box, box.os === 'windows' ? '(Get-FileHash -LiteralPath ' + psQuote(path) + ' -Algorithm SHA256).Hash' : (box.os === 'darwin' ? 'shasum -a 256 ' : 'sha256sum ') + shQuote(path), runner, signal, 12 * 3600_000)).trim().split(/\s/)[0]?.toLowerCase()
    if (!hash || !/^[a-f0-9]{64}$/.test(hash) || recipe.hashes?.[file] && hash !== recipe.hashes[file]) throw new Error('Downloaded model checksum failed: ' + file)
    rows.push(hash + '  ' + file)
  }
  await writeBoxFile(box, boxJoin(box, destination, 'SHA256SUMS'), rows.join('\n') + '\n', runner, signal)
}
