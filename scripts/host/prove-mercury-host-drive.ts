import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { boxFixture } from './boxFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const fixture = boxFixture(process.env.MERCURY_CONFIG_DIR)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.js')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_COMPAT_LABEL']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
const port = await new Promise<number>(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = (socket.address() as { port: number }).port; socket.close(() => resolve(port)) }) })
const file = 'Qwen3.8-27B-UD-Q4_K_M.gguf'
const hash = '322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482'
writeFileSync(join(fixture.bank, file), 'virtual bank fixture; bytes checked independently in prove-mercury-host')
writeFileSync(join(fixture.bank, 'SHA256SUMS'), hash + '  ' + file + '\n')
const facts = 'OS darwin\nARCH arm64\nHOME ' + fixture.home + '\nUID 501\nMEMORY 51539607552\nDISPLAYS {"SPDisplaysDataType":[{"sppci_model":"Fixture Apple GPU"}]}\nENGINE llamacpp|' + fixture.server + '|fixture|' + port + '\nBANK ' + fixture.bank + '\n'
const runner = { ...fixture.runner, async run(command: string, args: string[], signal: AbortSignal, timeout?: number) {
  const script = args.at(-1) ?? ''
  if (script.includes('system_profiler SPDisplaysDataType')) return facts
  if (script.includes('shasum -a 256') && script.includes(file)) return hash + '  ' + file + '\n'
  return fixture.runner.run(command, args, signal, timeout)
} }
let mounted: Mounted | undefined
const images: Promise<unknown>[] = []
let checks = 0
try {
  const { enableConfigs } = await import('../../src/utils/config.js'); enableConfigs()
  const { boxServiceFiles, writeBoxService } = await import('../../src/services/host/boxService.js')
  const { boxFacts } = await import('../../src/services/host/boxes.js')
  const machine = boxFacts({ name: 'this-computer', kind: 'this-computer' }, facts)
  writeBoxService({ name: machine.name, recipe: '', model: '', engine: 'llamacpp', destination: fixture.bank, bank: true, port, ...boxServiceFiles(machine), state: 'uninstalled' })
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
  const popup = await import('../../src/utils/cockpit/settingsPopup.js')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.js')
  const { createHostRoad } = await import('../../src/services/host/index.js')
  const { namedCompatModelOptions } = await import('../../src/services/providers/openaicompat/compatCatalogue.js')
  const road = createHostRoad({ runner })
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  open()
  const element = (width: number, height: number) => React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot))))
  mounted = await mountOffscreen(element(140, 44), 140, 44)
  const m = mounted
  const until = async (text: string) => assert.ok(await waitFor(() => m.screen().includes(text), 20000), 'screen reaches ' + text + '\n' + m.screen())
  const heading = async (text: string) => assert.ok(await waitFor(() => m.lines().slice(0, 4).join(' ').includes(text), 20000), 'heading reaches ' + text + '\n' + m.screen())
  const capture = (name: string, cols = 140, rows = 44) => {
    assert.ok(!m.screen().includes('RENDER ERROR')); checks++
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), m.screen())
    const grid = m.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const style = m.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false } }))
    const path = join(frames, name + '.json'); writeFileSync(path, JSON.stringify({ grid, cols, rows })); images.push(gridToPng(path, join(frames, name + '.png')))
  }
  const choose = async (text: string) => {
    for (let i = 0; i < 30; i++) { const before = m.lines().find(line => line.includes('› ')) ?? ''; if (before.includes(text)) { m.push(KEY.enter); return } m.push(KEY.down); assert.ok(await waitFor(() => (m.lines().find(line => line.includes('› ')) ?? '') !== before, 3000), 'selection moves toward ' + text + '\n' + m.screen()) }
    throw new Error('choice absent: ' + text)
  }
  const close = async () => { m.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  await heading('Where should the model run?'); await until('One of my computers'); capture('01-four-doors'); await choose('One of my computers')
  await heading('One of my computers'); capture('02-computers'); await choose('This computer')
  await heading('Computer · this-computer'); capture('03-uninstalled'); await choose('Choose a model')
  await heading('Choose a model for'); await until('needs 200 GB; this box has 48'); capture('04-memory-fits')
  await choose('GLM-5.3-Flash'); await heading('Choose a model for'); assert.ok(!fixture.commands.some((c: any) => c.args.at(-1)?.includes('launchctl bootstrap')))
  await choose('Back to this computer'); await heading('Computer · this-computer'); await choose('Choose a model'); await heading('Choose a model for'); await choose('GGUF Q4_K_M')
  await heading('Where are the weights?'); capture('05-weights'); await choose('Use a verified bank')
  await heading('Verified bank folder'); capture('06-bank-folder'); m.push(KEY.enter)
  await heading('Confirm model service'); await until('no weights download'); capture('07-start-confirm')
  assert.ok(m.screen().includes('huggingface.co/unsloth/Qwen3.8-27B-GGUF'), 'source is visible on full confirmation')
  assert.ok(m.screen().replace(/[│\s]+/g, ' ').includes('runs while you are logged in on this-computer and returns at login after a reboot'), 'the confirmation says how long the service runs')
  m.resize(element(64, 16), 64, 16); await until('Enlarge the terminal')
  m.push(KEY.down); m.push(KEY.enter); await new Promise(resolve => setImmediate(resolve))
  assert.ok(!fixture.commands.some((c: any) => c.args.at(-1)?.includes('launchctl bootstrap')), 'hidden confirmation details cannot start a service')
  capture('07a-narrow-confirmation', 64, 16)
  m.resize(element(140, 44), 140, 44); await until('no weights download')
  assert.ok(!fixture.commands.some((c: any) => c.args.at(-1)?.includes('launchctl bootstrap')), 'no service before explicit confirmation')
  await choose('Confirm installation and start'); await heading('Computer · this-computer'); await until('slots busy'); capture('08-running')
  assert.ok(namedCompatModelOptions().some(row => row.value.includes('compat/box-this-computer/unsloth/Qwen3.8-27B-GGUF')))
  await choose('Read engine logs'); await heading('Engine logs'); capture('09-logs'); await choose('Back to this computer')
  await heading('Computer · this-computer'); await choose('Stop the service'); await heading('Confirm stop'); capture('10-stop-confirm'); await choose('Confirm stop')
  await heading('Computer · this-computer'); await until('engine stopped'); capture('11-stopped')
  assert.match(namedCompatModelOptions().find(row => row.value.includes('compat/box-this-computer/'))!.unavailable!, /engine stopped — \/llmhost starts it/)
  await choose('Start the saved service'); await heading('Confirm restart'); capture('12-restart-confirm'); await choose('Confirm restart'); await heading('Computer · this-computer'); await until('slots busy'); capture('13-restarted')
  await choose('Uninstall the service'); await heading('Confirm uninstall'); capture('14-uninstall-confirm'); await choose('Confirm uninstall'); await heading('Computer · this-computer'); await until('no service installed'); capture('15-uninstalled')
  await choose('Choose a model'); await heading('Choose a model for'); await choose('GGUF Q4_K_M'); await heading('Where are the weights?'); await choose('Download to a folder')
  await heading('Download folder'); capture('24-download-destination'); m.push(KEY.enter); await heading('Confirm model service'); await until('~17 GB'); capture('25-download-size-confirm'); await choose('Keep things as they are'); await heading('Computer · this-computer'); await close()
  assert.equal(readFileSync(join(fixture.bank, file), 'utf8').startsWith('virtual bank'), true)
  open(); await heading('Where should'); await choose('One of my computers'); await heading('One of my computers'); await choose('Add a box over SSH')
  for (const [title, text, frame] of [['Name this computer','drive-remote','16-box-name'],['SSH host','fixture.invalid','17-box-host'],['SSH user','','18-box-user'],['SSH port','','19-box-port'],['Private key path','','20-box-key']] as const) { await heading(title); capture(frame); if(text) { m.push(text); await until(text) } m.push(KEY.enter) }
  await heading('Operating system'); capture('21-box-os'); await choose('macOS'); await heading('Computer · drive-remote'); capture('22-remote-recorded'); await close()
  open(); await heading('Where should'); await choose('One of my computers'); await heading('One of my computers'); await until('drive-remote'); capture('23-saved-box'); await close()
  await Promise.all(images)
  console.log('MERCURY HOST DRIVE GREEN · ' + checks + ' frames; real popup, fixture service binary, no live SSH or model downloads')
} finally { mounted?.unmount(); await fixture.close() }
