import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
pinSourceRef()
const width = process.argv.includes('--80') ? 80 : 120
const height = width === 80 ? 24 : 44
const f = await llmhostFixture()
process.env.HOME = f.home
if (process.platform === 'win32') process.env.USERPROFILE = f.home
let mounted: Mounted | undefined
try {
  assert.ok(existsSync(f.root + '/src/services/host/keepSafe.ts'), 'Bank needs a keep-safe action with a verified second-drive copy')
  const safe = await import(f.root + '/src/services/host/keepSafe.ts')
  const bank = await import(f.root + '/src/services/host/bank.ts')
  const { HOST_RECIPES } = await import(f.root + '/src/services/host/recipes.ts')
  const bytes = Buffer.from('a complete fixture model bank')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const config = Buffer.from('{"model_type":"fixture"}')
  const tokenizer = Buffer.from('{"version":"fixture"}')
  const recipe = { ...HOST_RECIPES[0], id: 'keep-safe-fixture', label: 'Keep safe fixture', model: 'fixture/keep-safe', weightFile: 'weights.gguf', mmproj: undefined, weightsGb: (bytes.length + config.length + tokenizer.length) / 1e9, include: '', source: 'https://huggingface.co/fixture/keep-safe/tree/' + 'a'.repeat(40), weightManifest: undefined }
  assert.deepEqual(bank.bankCandidates(), [join(f.home, 'mercury-model-bank'), join(f.home, 'models')], 'copy destinations stay inside the fixture home')
  const folder = bank.rememberBankFolder(join(f.home, 'mercury-model-bank'))
  const path = bank.bankModelFolder(folder, recipe)
  mkdirSync(path)
  writeFileSync(join(path, 'weights.gguf'), bytes)
  writeFileSync(join(path, 'SHA256SUMS'), hash + '  weights.gguf\n')
  writeFileSync(join(path, 'config.json'), config)
  writeFileSync(join(path, 'tokenizer.json'), tokenizer)
  assert.equal(bank.bankFiles(recipe, path).files.length, 3)
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  let mirrors = 0
  const notices: string[] = []
  const road = async (ask: any, emit: any, signal: AbortSignal) => { await safe.keepSafeDoor(recipe, folder, ask, (event: any) => { notices.push(event.words); emit(event) }, signal, async () => { mirrors++; return undefined }); return { ok: true, words: 'Keep safe finished' } }
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
  const until = async (text: string) => assert.ok(await waitFor(() => mounted!.screen().includes(text), 15000), text + '\n' + mounted!.screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const choose = async (text: string) => { for (let i = 0; i < 12 && !selected().includes(text); i++) { const before = selected(); mounted!.push(KEY.down); assert.ok(await waitFor(() => selected() !== before, 3000)) }; assert.ok(selected().includes(text), text + '\n' + mounted!.screen()); mounted!.push(KEY.enter) }
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  open(); await until('Copy to another drive')
  const frameAt = process.argv.indexOf('--frames')
  if (frameAt >= 0) {
    const frames = process.argv[frameAt + 1]!
    mkdirSync(frames, { recursive: true })
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    const file = join(frames, 'keep-safe.json')
    writeFileSync(file, JSON.stringify({ grid, cols: width, rows: height }))
    const { gridToPng } = await import('../ui/gridToPng.ts')
    await gridToPng(file, join(frames, 'keep-safe.png'))
  }
  await choose('Copy to another drive'); await until('Copy to which drive?'); await choose(join('~', 'models')); await until('Confirm bank copy')
  const destination = bank.bankModelFolder(join(f.home, 'models'), recipe)
  assert.equal(existsSync(destination), false)
  await choose('Copy and verify'); await until('Keep safe finished')
  assert.deepEqual(readFileSync(join(destination, 'weights.gguf')), bytes)
  assert.deepEqual(readFileSync(join(destination, 'config.json')), config)
  assert.deepEqual(readFileSync(join(destination, 'tokenizer.json')), tokenizer)
  const completeSums = [hash + '  weights.gguf', createHash('sha256').update(config).digest('hex') + '  config.json', createHash('sha256').update(tokenizer).digest('hex') + '  tokenizer.json'].join('\n') + '\n'
  assert.equal(readFileSync(join(destination, 'SHA256SUMS'), 'utf8'), completeSums)
  assert.equal((await bank.verifyBank(recipe, join(f.home, 'models'), new AbortController().signal)).files, 3)
  assert.equal(readFileSync(join(path, 'SHA256SUMS'), 'utf8'), hash + '  weights.gguf\n')
  assert.deepEqual(readFileSync(join(path, 'weights.gguf')), bytes)
  assert.ok(notices.some(text => text.includes('Copied and verified every file')))
  await close()
  await assert.rejects(safe.copyBankToFolder(recipe, folder, join(f.home, 'models'), new AbortController().signal), /already holds/)
  assert.ok(!readdirSync(join(f.home, 'models')).some(name => name.startsWith('.mercury-copy-')))
  open(); await until('Mirror to a Runpod'); await choose('Mirror to a Runpod'); await until('Keep safe finished'); await close()
  assert.equal(mirrors, 1)
  open(); await until('Upload on first boot'); await choose('Upload on first boot'); await until('Measured upload speed (Mbps)'); mounted!.push('25'); await until('25'); mounted!.push(KEY.enter); await until('Upload this bank on first boot?')
  assert.equal(safe.bankUploadPreference(recipe), undefined)
  assert.ok(mounted!.screen().includes('bills throughout the upload'))
  await choose('Use my bank on first boot'); await until('Keep safe finished'); await close()
  assert.equal(safe.bankUploadPreference(recipe).bytesPerSecond, 25e6 / 8)
  assert.ok(safe.bankUploadEstimate({ ...recipe, weightsGb: 510 }).includes('45.3 hours'))
  const calls: { command: string; args: string[] }[] = []
  const runner = { run: async (command: string, args: string[]) => { calls.push({ command, args }); if (command === 'rsync') { const list = args.find(arg => arg.startsWith('--files-from='))!.slice(13); assert.deepEqual(readFileSync(list, 'utf8').trim().split('\n').sort(), ['config.json', 'tokenizer.json', 'weights.gguf']); assert.ok(args.includes(realpathSync(path) + '/')) }; return '' }, tunnel: () => { throw new Error('No tunnel is needed') } }
  assert.equal(await safe.uploadBankForRental(recipe, 'runpod', { host: '127.0.0.1' }, runner, new AbortController().signal), undefined)
  assert.equal(calls.length, 0)
  const remote = await safe.uploadBankForRental(recipe, 'vast', { host: '127.0.0.1', user: 'root' }, runner, new AbortController().signal)
  assert.equal(remote, '/workspace/mercury-host/keep-safe-fixture/bank-weights')
  assert.equal(calls.filter(call => call.command === 'rsync').length, 1)
  assert.ok(calls.at(-1)?.args.at(-1)?.includes('sha256sum -c SHA256SUMS'))
  assert.ok(calls.at(-1)?.args.at(-1)?.includes(completeSums))
  assert.equal(safe.bankUploadPreference(recipe).source, 'transfer')
  assert.ok(!readdirSync(join(f.home, 'host')).some(name => name.startsWith('bank-transfer-')))
  const failed = { ...runner, run: async (command: string, args: string[]) => { if (args.at(-1)?.includes('sha256sum')) throw new Error('checksum mismatch'); return '' } }
  await assert.rejects(safe.uploadBankForRental(recipe, 'lambda', { host: '127.0.0.1' }, failed, new AbortController().signal), /checksum mismatch/)
  safe.rememberBankUpload(recipe, undefined)
  assert.equal(safe.bankUploadPreference(recipe), undefined)
  console.log('PASS keep safe at ' + width + ' columns: real popup copies every private-bank file including unsealed config and tokenizer, checks all copied and uploaded files, preserves the original seal, refuses overwrite and removes temporary files')
} finally { mounted?.unmount(); f.close() }
