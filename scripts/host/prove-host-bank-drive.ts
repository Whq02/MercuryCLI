import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bankDownloadWords } from './bankDownloadFixture.ts'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
f.state.dialect = 'sglang'; f.state.window = 131072
process.env.HOME = f.home
if (process.platform === 'win32') process.env.USERPROFILE = f.home
const normalPath = (path: string): string => path.replaceAll('\\', '/')
const shortBankFolder = join('~', 'mercury-model-bank')
const rp = await runpodFixture()
const vast = await vastFixture()
const lambda = await lambdaFixture()
const hf = await hfEndpointsFixture()
lambda.state.types.push({ name: 'gpu_1x_rtxpro6000', description: '1x RTX PRO 6000', gpu_description: 'NVIDIA RTX PRO 6000 Blackwell (96 GB)', price_cents_per_hour: 210, specs: { vcpus: 32, memory_gib: 256, storage_gib: 2000, gpus: 1 }, architecture: 'x86_64' })
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const base = ({ 'https://api.runpod.io': rp.baseUrl.replace('/v2', ''), 'https://console.vast.ai': vast.baseUrl.replace('/api/v0', ''), 'https://cloud.lambda.ai': lambda.baseUrl.replace('/api/v1', ''), 'https://api.endpoints.huggingface.cloud': hf.origin, 'https://huggingface.co': hf.origin } as Record<string, string>)[url.origin]
  if (base) return nativeFetch(new Request(base + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Bank proof only permits loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const gitBlob = (data: Buffer): string => createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex')
const hub: Record<string, Record<string, Buffer>> = {
  'fixture/tiny-a': { 'shards/tiny-a-00001-of-00002.bin': randomBytes(4096), 'shards/tiny-a-00002-of-00002.bin': randomBytes(6144) },
  'fixture/tiny-b': { 'model.bin': randomBytes(8192) },
}
const manifests = [
  { model: 'fixture/tiny-a', include: '', revision: 'a'.repeat(40), files: [{ path: 'shards/tiny-a-00001-of-00002.bin', size: 4096, sha256: sha256(hub['fixture/tiny-a']!['shards/tiny-a-00001-of-00002.bin']!) }, { path: 'shards/tiny-a-00002-of-00002.bin', size: 6144, git: gitBlob(hub['fixture/tiny-a']!['shards/tiny-a-00002-of-00002.bin']!) }] },
  { model: 'fixture/tiny-b', include: '', revision: 'b'.repeat(40), files: [{ path: 'model.bin', size: 8192, sha256: sha256(hub['fixture/tiny-b']!['model.bin']!) }] },
]
const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../../assets/host/recipes.json'), 'utf8')) as { version: number; publishedAt: string; recipes: any[] }
const shape = shipped.recipes.find(row => row.id === 'qwen38-27b-rtx-pro-6000')
assert.ok(shape, 'the shipped Qwen RTX PRO 6000 recipe is the shape the fixture recipes copy')
const fixtureRecipe = (id: string, title: string, model: string, weightsGb: number) => ({ ...shape, id, label: title + ' · FP8', model, weightsGb, source: 'https://huggingface.co/' + model, verification: 'documented', verified: { by: 'documented', on: '2026-10-22', note: 'fixture recipe for the bank proof', source: 'https://huggingface.co/' + model }, efforts: undefined })
const recipesFile = join(f.home, 'recipes.json')
writeFileSync(recipesFile, JSON.stringify({ version: shipped.version, publishedAt: shipped.publishedAt, recipes: [fixtureRecipe('tiny-a-rtx-pro-6000', 'Tiny-A', 'fixture/tiny-a', 10240 / 1e9), fixtureRecipe('tiny-b-rtx-pro-6000', 'Tiny-B', 'fixture/tiny-b', 8192 / 1e9)] }))
const weightsFile = join(f.home, 'weights.json')
writeFileSync(weightsFile, JSON.stringify(manifests))
process.env.MERCURY_HOST_RECIPES_FILE = recipesFile
process.env.MERCURY_HOST_WEIGHTS_FILE = weightsFile
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
let checks = 0
const notices = (): string[] => { const dir = join(f.home, 'host', 'notices'); try { return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')).words as string) } catch { return [] } }
const check = (name: string, truth: unknown) => { if (!truth) { console.log('NOTICES ' + JSON.stringify(notices().map(words => words.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()), null, 1)); console.log(mounted?.screen() ?? '') } assert.ok(truth, name); checks++; console.log('PASS ' + name) }
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { hostRecords, readHostRecord } = await import('../../src/services/host/store.ts')
  const { writeStoredHuggingfaceApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const bank = await import('../../src/services/host/bank.ts')
  const volumes = await import('../../src/services/host/volumes.ts')
  const recipes = currentHostRecipes()
  assert.ok(bank.bankCandidates().length > 0 && bank.bankCandidates().every(path => normalPath(path).startsWith(normalPath(f.home) + '/')) && bank.bankFolder() === undefined, 'the proof looks for a bank only inside its scratch home: ' + bank.bankCandidates().join(', '))
  check('the fixture recipes replace the shipped list and carry pinned manifests', recipes.length === 2 && recipes.every(recipe => bank.bankFiles(recipe, '/none').pinned))
  const hfToken = hf.key
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const downloads: { model: string; revision?: string; include: string[]; localDir: string; token?: string }[] = []
  const runner = { ...ssh.runner, run: async (command: string, args: string[], signal: AbortSignal, timeoutMs?: number, env?: Record<string, string>) => {
    const words = bankDownloadWords(command, args)
    if (words) {
      const at = (flag: string) => words.indexOf(flag)
      const include = at('--include') < 0 ? [] : words.slice(at('--include') + 1, at('--local-dir'))
      const download = { model: words[2]!, revision: at('--revision') < 0 ? undefined : words[at('--revision') + 1], include, localDir: words[at('--local-dir') + 1]!, token: env?.HF_TOKEN }
      downloads.push(download)
      const files = hub[download.model]
      assert.ok(files, 'the fixture hub knows ' + download.model)
      for (const [path, data] of Object.entries(files)) {
        if (include.length && !include.includes(path)) continue
        mkdirSync(join(download.localDir, path, '..'), { recursive: true })
        writeFileSync(join(download.localDir, path), data)
      }
      return ''
    }
    if (args[0] === 'ssh' && args[1]?.at(-1)?.includes('nvidia-smi')) return 'NVIDIA RTX PRO 6000 Blackwell, 98304\nDOCKER_ENGINE_PRESENT\n'
    return ssh!.runner.run(command, args, signal, timeoutMs)
  } }
  const jobs: Promise<void>[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner, pauseMs: 10, readyTimeoutMs: 2000, sessionId: 'bank-proof', startJob: record => { jobs.push(runHostJob(record.id, record.generation!, { runner, pauseMs: 10, timeoutMs: 4000, keepAlive: false })) } })
  let width = 120
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  const mount = async (columns: number) => {
    width = columns
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: 44 }, React.createElement(SettingsPopupSlot)))), columns, 44)
  }
  const screen = () => mounted!.screen()
  const until = async (needle: string) => assert.ok(await waitFor(() => screen().includes(needle), 20000), 'screen reaches ' + needle + '\n' + screen())
  const heading = async (needle: string) => assert.ok(await waitFor(() => mounted!.lines().slice(0, 4).join(' ').includes(needle), 20000), 'question reaches ' + needle + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const select = async (needle: string) => {
    for (let n = 0; n < 40; n++) {
      const before = selected()
      if (before.includes(needle)) return
      mounted!.push(KEY.down)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'selection reaches ' + needle + '\n' + screen())
    }
    throw new Error('Choice not found: ' + needle)
  }
  const choose = async (needle: string) => { await select(needle); mounted!.push(KEY.enter) }
  const press = async (needle: string, key: string) => { await select(needle); mounted!.push(key) }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const capture = async (name: string) => {
    const text = screen()
    check(name + ' renders without errors, keys or tokens', !text.includes('RENDER ERROR') && !text.includes(rp.key) && !text.includes(vast.key) && !text.includes(lambda.key) && !text.includes(hfToken))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), text)
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: 44 }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  const openBank = async () => { open(); await heading('Which model?'); await choose('More options'); await heading('Where should the model run?'); await choose('Bank · your weights') }
  const bankFolder = join(f.home, 'mercury-model-bank')
  const tinyA = recipes.find(recipe => recipe.model === 'fixture/tiny-a')!
  const tinyB = recipes.find(recipe => recipe.model === 'fixture/tiny-b')!
  const row = (title: string) => mounted!.lines().find(line => line.includes(title)) ?? ''
  const rowStart = /^(Rent · |Bank · |Watch stock|No stock|Back to|Already|Connect |Choose quality|Runpod stock|Vast\.ai · |Lambda · )/
  const modelRows = (): string[] => {
    const lines = mounted!.lines().map(line => line.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, ''))
    const start = lines.findIndex(line => line.trim() === 'WHERE')
    const rows: string[] = []
    for (const line of lines.slice(start + 1)) {
      const text = line.replace(/^(› |  )/, '').trimEnd()
      if (line.includes('esc closes')) break
      if (line.startsWith('↑↓')) continue
      if (rowStart.test(text)) rows.push(text)
      else if (rows.length && text.trim()) rows[rows.length - 1] += ' ' + text.trim()
    }
    return rows
  }

  await mount(120)
  await openBank(); await heading('Where should the bank live?')
  check('with no bank folder on this computer the Bank asks for one, suggesting ' + shortBankFolder, screen().includes('No bank folder was found') && screen().includes(shortBankFolder))
  mounted!.push(KEY.enter); await heading('Bank')
  check('the named folder is created and remembered in bank.json', bank.bankFolder() === bankFolder && JSON.parse(readFileSync(join(f.home, 'host', 'bank.json'), 'utf8')).folder === bankFolder)
  check('the Bank table has the header, one row per model, both unbanked, and the totals', screen().includes('MODEL') && screen().includes('BANKED') && screen().includes('VERIFIED') && screen().includes('VOLUME') && row('Tiny-A').includes('— b to bank') && row('Tiny-B').includes('— b to bank') && screen().includes('Banked: 0 of 2 models'))
  check('the hint names the five keys on one line at 120 columns', screen().includes('b bank · v verify · m mirror · d drop · k keep safe · esc closes'))
  await capture('120-bank-empty')
  await close()
  const folderA = bank.bankModelFolder(bankFolder, tinyA)
  for (const [path, data] of Object.entries(hub['fixture/tiny-a']!)) { mkdirSync(join(folderA, path, '..'), { recursive: true }); writeFileSync(join(folderA, path), data) }
  writeFileSync(join(folderA, 'SHA256SUMS'), Object.entries(hub['fixture/tiny-a']!).map(([path, data]) => sha256(data) + '  ' + path).join('\n') + '\n')
  check('a folder holding every pinned file and a SHA256SUMS counts as banked before any verification', bank.bankState(tinyA).banked && !bank.bankState(tinyA).verifiedAt && !bank.bankState(tinyB).banked)
  await openBank(); await heading('Bank')
  check('the banked row shows the folder, no verification date and m to mirror', row('Tiny-A').includes('✓ ~ ') && row('Tiny-A').includes('— m to mirror') && !row('Tiny-A').includes('✓ 2026') && screen().includes('Banked: 1 of 2 models'))
  await capture('120-bank-one-banked')
  await press('Tiny-A', 'v')
  await until('Verifying the bank')
  await Promise.all(jobs)
  check('v queues a verification job that passes against the pinned manifest and leaves a notice', notices().some(words => words.includes('Tiny-A · verified against the pinned manifest · 2 files')) && bank.bankState(tinyA).verifiedAt !== undefined && bank.bankState(tinyA).check === 'manifest' && hostRecords().every(record => record.jobKind !== 'bank'))
  await choose('Refresh'); await heading('Bank'); await until('✓ ' + new Date().toISOString().slice(0, 10))
  check('the verified date lands in the VERIFIED column', row('Tiny-A').includes('✓ ' + new Date().toISOString().slice(0, 10)) && screen().includes('last verified ' + new Date().toISOString().slice(0, 10)))
  await close(); mounted!.unmount(); await mount(80)
  await openBank(); await heading('Bank'); await capture('80-bank-one-banked')
  check('at 80 columns the table header and both rows are still on screen', screen().includes('MODEL') && screen().includes('Tiny-A') && screen().includes('Tiny-B'))
  await close(); mounted!.unmount(); await mount(120)
  const shard = join(folderA, 'shards/tiny-a-00002-of-00002.bin')
  const original = readFileSync(shard)
  const flipped = Buffer.from(original); flipped[100] = flipped[100]! ^ 0xff
  writeFileSync(shard, flipped)
  await openBank(); await heading('Bank'); await press('Tiny-A', 'v'); await until('Verifying the bank'); await Promise.all(jobs)
  check('a flipped byte fails verification against the pinned manifest, names the file, and leaves a failed notice', notices().some(words => words.includes('Tiny-A · verification failed: shards/tiny-a-00002-of-00002.bin · content differs from the pinned manifest')) && bank.bankState(tinyA).verifiedAt === undefined && bank.bankState(tinyA).failedAt !== undefined)
  await choose('Refresh'); await heading('Bank'); await until('✗ ')
  check('the failed verification shows in the VERIFIED column while the files stay banked', row('Tiny-A').includes('✗ ' + new Date().toISOString().slice(0, 10)) && row('Tiny-A').includes('✓ ~ '))
  writeFileSync(shard, original)
  const queuedBeforeRestore = jobs.length
  await press('Tiny-A', 'v'); assert.ok(await waitFor(() => jobs.length > queuedBeforeRestore, 5000), 'restored-byte verification is queued'); await Promise.all(jobs)
  check('restoring the byte verifies again', bank.bankState(tinyA).verifiedAt !== undefined)
  await close()
  open(); await heading('Which model?'); await choose('Tiny-B'); await heading('Tiny-B'); await until('WEIGHTS')
  const unbanked = screen().replace(/[│\s]+/g, ' ')
  check('the model screen WEIGHTS line reads not banked and no fast-load volume with the download estimate', unbanked.includes('WEIGHTS') && unbanked.includes('8.2 KB from Hugging Face · not banked · no fast-load volume — first boot downloads (~') && /first boot downloads \(~\d+ min\)/.test(unbanked))
  check('the Bank row offers b with the folder and size, and nobody is connected so no Rent or watch row', unbanked.includes('Bank · b bank the weights to ' + shortBankFolder + ' (8.2 KB, hash-verified)') && !unbanked.includes('Rent ·') && !unbanked.includes('Watch stock'))
  await capture('120-model-unbanked')
  writeStoredHuggingfaceApiKey(hfToken)
  await press('Bank · b bank', 'b'); await heading('Bank Tiny-B')
  check('b asks a confirm that names the source, the folder, the token use and the pinned manifest before any download', screen().includes('https://huggingface.co/fixture/tiny-b') && screen().includes('Hugging Face token is used when a repo is gated') && screen().includes('against the pinned manifest') && downloads.length === 0)
  await choose('Bank it'); await until('Banking the weights to ' + shortBankFolder)
  await Promise.all(jobs)
  check('the bank job downloads with hf download, the pinned revision and file list, the local dir and the stored token in the environment, never on the command line', downloads.length === 1 && downloads[0]!.model === 'fixture/tiny-b' && downloads[0]!.revision === manifests[1]!.revision && downloads[0]!.include.join() === 'model.bin' && downloads[0]!.localDir === bank.bankModelFolder(bankFolder, tinyB) && downloads[0]!.token === hfToken)
  check('the download is sealed with SHA256SUMS, verified against the pinned manifest and announced', readFileSync(join(bank.bankModelFolder(bankFolder, tinyB), 'SHA256SUMS'), 'utf8') === sha256(hub['fixture/tiny-b']!['model.bin']!) + '  model.bin\n' && bank.bankState(tinyB).banked && bank.bankState(tinyB).check === 'manifest' && notices().some(words => words.includes('Tiny-B · banked on ' + shortBankFolder + ' · 8.2 KB in 1 files · verified against the pinned manifest')))
  await close(); open(); await heading('Which model?'); await choose('Tiny-B'); await heading('Tiny-B'); await until('WEIGHTS')
  const banked = screen().replace(/[│\s]+/g, ' ')
  check('the banked WEIGHTS line distinguishes rented downloads and the key rail offers bank again', banked.includes('banked ✓ on ' + shortBankFolder + ' (verified ' + new Date().toISOString().slice(0, 10) + ')') && banked.includes('a rented machine downloads from Hugging Face (~') && banked.includes('your bank serves your own computers and a mirror') && banked.includes('b bank again') && !banked.includes('first boot downloads') && banked.includes('Bank · weights banked ✓ on ' + shortBankFolder + ' · v verify again · m mirror to a fast-load volume'))
  await capture('120-model-banked')
  for (const [vendor, label, fixture] of [['runpod', 'Runpod', rp], ['vast', 'Vast.ai', vast], ['lambda', 'Lambda', lambda]] as const) {
    await choose('Connect ' + label); await heading(label + ' API key'); mounted!.push(fixture.key); await until('********'); mounted!.push(KEY.enter)
    await until('Rent · ' + label)
    check(label + ' connects and lists its in-stock rental on the model screen', vendor.length > 0 && mounted!.lines().some(line => line.includes('Rent · ' + label) && line.includes('in stock')))
  }
  await until('Rent · Hugging Face')
  const rentRows = modelRows().filter(line => line.startsWith('Rent · '))
  const prices = rentRows.map(line => Number(/\$([\d.]+)\/hr/.exec(line)?.[1]))
  check('every connected provider is side by side, cheapest first (two Vast.ai machines, two Lambda regions, Runpod, Hugging Face)', rentRows.length === 6 && rentRows[0]!.startsWith('Rent · Vast.ai') && rentRows[1]!.startsWith('Rent · Vast.ai') && rentRows[4]!.startsWith('Rent · Runpod') && rentRows[5]!.startsWith('Rent · Hugging Face') && prices.every((price, index) => index === 0 || price >= prices[index - 1]!))
  check('no provider row carries a stamp about who booted it', rentRows.every(line => !line.includes('booted') && !line.includes('verified on')))
  check('without a volume every row downloads the weights first', rentRows.every(line => line.includes('downloads the weights first')) && !screen().includes('Runpod-only'))
  await select('Watch stock')
  check('one watch row covers every provider', modelRows().filter(line => line.startsWith('Watch stock · across every provider above')).length === 1)
  await capture('120-model-three-vendors')
  await close(); mounted!.unmount(); await mount(80)
  open(); await heading('Which model?'); await choose('Tiny-B'); await heading('Tiny-B'); await select('Rent · Runpod'); await capture('80-model-three-vendors')
  const paged = modelRows().filter(line => line.startsWith('Rent · '))
  check('at 80 columns the rows page to the Runpod rental and the visible rentals stay in price order', paged.length === 4 && ['Rent · Lambda', 'Rent · Lambda', 'Rent · Runpod', 'Rent · Hugging Face'].every((vendor, index) => paged[index]!.startsWith(vendor)) && paged.map(line => Number(/\$(\d+\.\d+)\/hr/.exec(line)?.[1] ?? NaN)).every((price, index, all) => index === 0 || price >= all[index - 1]!))
  await close(); mounted!.unmount(); await mount(120)
  await openBank(); await heading('Bank'); await press('Tiny-A', 'm'); await heading('How?')
  check('m opens the mirror road with the volume kinds', screen().includes('network volume') && screen().includes('global volume'))
  await choose('network volume'); await heading('Where should'); await until('EU-NL-1'); await choose('EU-NL-1'); await heading('When should'); await choose('Prepare now'); await heading('Confirm weights disk')
  check('the mirror confirm says a temporary pod fills the volume from Hugging Face and nothing is uploaded from the drive', screen().replace(/[│\s]+/g, ' ').includes('A temporary pod fills the volume from Hugging Face and verifies the same files next to the GPUs; nothing is uploaded from your drive') && rp.state.volumeCreates === 0 && rp.state.creates === 0)
  await choose('Confirm $'); await heading('Bank')
  assert.ok(await waitFor(() => volumes.keptVolumes().some(volume => volume.state === 'kept'), 20000), 'the fill pod verifies the weights on the volume\n' + screen())
  await Promise.all(jobs)
  const kept = volumes.keptVolumes().find(volume => volume.model === tinyA.model)!
  check('the mirror creates one volume and one temporary pod, which is terminated after verification', rp.state.volumeCreates === 1 && rp.state.creates === 1 && rp.state.deletes === 1 && rp.state.pods.size === 0 && kept.state === 'kept' && kept.dataCenter === 'EU-NL-1')
  await choose('Refresh'); await heading('Bank'); await until('✓ EU-NL-1')
  check('the VOLUME column shows the data centre and the boot estimate, and the totals count the volume', /✓ EU-NL-1 · boots ~\d+ min/.test(row('Tiny-A')) && screen().replace(/[│\s]+/g, ' ').includes('fast-load volumes: 1 kept'))
  await capture('120-bank-volume')
  await close(); open(); await heading('Which model?'); await choose('Tiny-A'); await heading('Tiny-A'); await until('Rent · Runpod')
  const withVolume = screen().replace(/[│\s]+/g, ' ')
  check('with a kept volume the WEIGHTS line names it and the Runpod row boots from it while the others download', /fast-load volume ✓ EU-NL-1 — boots in ~\d+ min/.test(withVolume) && modelRows().some(line => line.startsWith('Rent · Runpod') && line.includes('boots from your volume')) && modelRows().filter(line => line.startsWith('Rent · ') && !line.includes('Runpod')).every(line => line.includes('downloads the weights first')))
  await capture('120-model-volume')
  await close(); await openBank(); await heading('Bank'); await press('Tiny-A', 'd'); await heading('Delete weights disk?')
  await choose('Confirm Delete'); await heading('Bank'); await until('Weights disk deleted')
  check('d drops the volume copy and the bank on the drive stays', rp.state.volumeDeletes === 1 && volumes.readKeptVolume(kept.id)?.state === 'gone' && bank.bankState(tinyA).banked && screen().includes('the bank on your drive is untouched'))
  await close()
  rp.state.noStock = true; vast.state.noStock = true; lambda.state.noStock = true; hf.state.noStock = true
  open(); await heading('Which model?'); await choose('Tiny-B'); await heading('Tiny-B'); await until('No stock · watch')
  check('with no stock anywhere the watch row says so and the four providers keep their rows', !screen().includes('Rent · ') && ['Runpod', 'Vast.ai', 'Lambda', 'Hugging Face'].every(label => screen().includes(label)))
  await choose('No stock · watch'); await heading('Confirm the hourly price')
  const watchConfirm = screen().replace(/[│\s]+/g, ' ')
  check('the watch confirm names every provider, the per-provider read rate and the first-hit rule, and rents nothing', watchConfirm.includes('across Runpod, Vast.ai, Lambda, Hugging Face') && watchConfirm.includes('one catalogue read per provider (4)') && watchConfirm.includes('The first provider with stock at or under the ceiling rents it') && rp.state.creates === 1 && vast.state.creates === 0 && lambda.state.creates === 0)
  await choose('Watch for stock and rent at this price or less'); await heading('Machine controls')
  assert.ok(await waitFor(() => hostRecords().some(record => record.jobKind === 'watch' && record.jobState === 'running'), 10000), 'the watch job runs')
  const watch = hostRecords().find(record => record.jobKind === 'watch')!
  check('the watch record covers the four providers and polls them without renting', watch.watchVendors?.join() === 'runpod,vast,lambda,huggingface' && (await waitFor(() => vast.requests.filter((request: any) => request.path === '/api/v0/bundles/').length >= 2 && lambda.requests.filter((request: any) => request.path === '/api/v1/instance-types').length >= 2 && rp.state.catalogReads >= 2 && hf.requests.filter((request: any) => request.path === '/v2/provider/fixture-owner').length >= 2, 10000)) && vast.state.creates === 0 && hf.state.creates === 0)
  vast.state.noStock = false
  check('when Vast.ai gets stock first the watch rents there and the setup reaches ready', await waitFor(() => hostRecords().some(record => record.watchedFrom === watch.id && record.vendor === 'vast' && record.jobState === 'ready'), 30000))
  await Promise.all(jobs)
  check('the watch rented exactly one instance, on Vast.ai, and its notice names the provider', vast.state.creates === 1 && lambda.state.creates === 0 && hf.state.creates === 0 && rp.state.creates === 1 && notices().some(words => words.includes('Rented Tiny-B · 1× RTX PRO 6000 · $1.21/hr · Vast.ai · setting up')) && !readHostRecord(watch.id))
  await close()
  check('no request left the loopback fixtures', escaped.length === 0)
  console.log('HOST BANK DRIVE GREEN — ' + checks + ' checks; real popup, the Bank screen at 120 and 80, b/v/m/d jobs with notices, the WEIGHTS line, three vendors side by side with stamps and boot words, a watch across providers; zero billable calls')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); await vast.close(); await lambda.close(); await hf.close(); f.close(); globalThis.fetch = nativeFetch }
