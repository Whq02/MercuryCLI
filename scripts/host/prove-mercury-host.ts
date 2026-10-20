import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.js')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_COMPAT_LABEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_.*_API_KEY$/.test(key)) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const root = new URL('../../', import.meta.url).pathname
assert.ok(existsSync(join(root, 'src/services/host/boxes.ts')), 'own computers are first-class recorded targets')
const { discoverBox, readBox, listBoxes } = await import('../../src/services/host/boxes.js')
const { boxInspectionScript, windowsBoxInspectionScript } = await import('../../src/services/host/ssh.js')
const facts = 'OS darwin\nARCH arm64\nHOME /fixture/home\nUID 501\nMEMORY 51539607552\nDISPLAYS {"SPDisplaysDataType":[{"sppci_model":"Apple test GPU"}]}\nENGINE ollama|/fixture/bin/ollama|0.34.4|11434\nENGINE llamacpp|/fixture/bin/llama-server|test-build|30000\nBANK /fixture/bank\n'
const commands: { command: string; args: string[] }[] = []
const runner = {
  async run(command: string, args: string[]) { commands.push({ command, args }); return facts },
  tunnel() { throw new Error('Discovery must not tunnel') },
}
const signal = new AbortController().signal
const remote = await discoverBox({ name: 'fixture', kind: 'ssh', target: { host: 'fixture.invalid', user: 'tester' }, os: 'darwin' }, runner, signal)
assert.equal(commands.length, 1, 'one SSH read discovers the box')
assert.equal(commands[0]!.command, 'ssh')
assert.equal(remote.memoryGb, 48)
assert.equal(remote.unifiedMemory, true)
assert.equal(remote.gpus[0]!.name, 'Apple test GPU')
assert.equal(remote.engines[0]!.kind, 'ollama')
assert.equal(remote.engines[0]!.version, '0.34.4')
assert.equal(remote.engines[0]!.port, 11434)
assert.deepEqual(remote.bankPaths, ['/fixture/bank'])
assert.equal(readBox('fixture')!.target!.host, 'fixture.invalid')
assert.equal(JSON.parse(readFileSync(join(process.env.MERCURY_CONFIG_DIR, 'host/boxes/fixture.json'), 'utf8')).memoryGb, 48)
const local = await discoverBox({ name: 'this-computer', kind: 'this-computer' }, runner, signal)
assert.equal(local.os, 'darwin')
assert.equal(commands[1]!.command, '/bin/sh')
assert.equal(listBoxes().length, 2)
const os = await import('node:os')
const actualFacts = 'OS ' + (os.platform() === 'win32' ? 'windows' : os.platform()) + '\nARCH ' + os.arch() + '\nHOME ' + process.env.MERCURY_CONFIG_DIR + '\nMEMORY ' + os.totalmem() + '\n'
const actual = await discoverBox({ name: 'actual-facts', kind: 'this-computer' }, { ...runner, async run() { return actualFacts } }, signal)
assert.equal(actual.memoryGb, os.totalmem() / 1024 ** 3)
assert.equal(actual.arch, os.arch())
assert.match(boxInspectionScript, /system_profiler SPDisplaysDataType/)
assert.match(boxInspectionScript, /sysctl -n hw.memsize/)
assert.match(windowsBoxInspectionScript, /Win32_ComputerSystem/)
await assert.rejects(() => discoverBox({ name: '../escape', kind: 'this-computer' }, runner, signal))
await assert.rejects(() => discoverBox({ name: 'bad', kind: 'ssh', target: { host: '-bad' } }, runner, signal))
console.log('MERCURY HOST GREEN · discovery, persistence, memory, engines and banks; fixtures only')
assert.ok(existsSync(join(root, 'src/services/host/boxRecipes.ts')), 'own computers have memory-based recipes')
const { BOX_RECIPES, fitsBox, boxFitWords, boxWeightsWords } = await import('../../src/services/host/boxRecipes.js')
const large = BOX_RECIPES.find(row => row.id === 'glm53-flash-gguf')!
assert.equal(fitsBox(large, local), false)
assert.equal(boxFitWords(large, local), 'needs 200 GB; this box has 48')
for (const recipe of BOX_RECIPES.filter(row => row.id !== large.id)) assert.equal(fitsBox(recipe, local), true, recipe.id)
assert.equal(BOX_RECIPES.filter(row => row.verified.by === 'measured').length, 1)
assert.equal(BOX_RECIPES.find(row => row.id === 'nemotron35-bolt')!.verified.on, '2026-10-19')
assert.match(boxWeightsWords(large, '/chosen/bank', false), /200 GB.*\/chosen\/bank/)
assert.match(boxWeightsWords(large, '/chosen/bank', true), /verify SHA256SUMS/)
console.log('MERCURY HOST GREEN · honest memory fits and download confirmation words')
const { mkdirSync, writeFileSync } = await import('node:fs')
const { createHash } = await import('node:crypto')
const { hostRunner } = await import('../../src/services/host/ssh.js')
const { verifyBoxBank } = await import('../../src/services/host/boxBank.js')
const bank = join(process.env.MERCURY_CONFIG_DIR, 'bank with spaces')
mkdirSync(bank, { recursive: true })
const contents = 'fixture model bytes'
writeFileSync(join(bank, 'model.gguf'), contents)
writeFileSync(join(bank, 'SHA256SUMS'), createHash('sha256').update(contents).digest('hex') + '  model.gguf\n')
const tiny = { ...large, files: ['model.gguf'] }
await verifyBoxBank(local, tiny, bank, hostRunner, signal)
writeFileSync(join(bank, 'model.gguf'), 'corrupt')
await assert.rejects(() => verifyBoxBank(local, tiny, bank, hostRunner, signal), /checksum failed/)
writeFileSync(join(bank, 'SHA256SUMS'), '0'.repeat(64) + '  ../escape\n')
await assert.rejects(() => verifyBoxBank(local, tiny, bank, hostRunner, signal), /Unsafe path/)
console.log('MERCURY HOST GREEN · bank verifies bytes, completeness and safe paths')
assert.ok(existsSync(join(root, 'src/services/host/boxService.ts')), 'engines have persistent owned services')
const { boxServiceDocument, boxServiceFiles, boxServiceRunning, controlBoxService } = await import('../../src/services/host/boxService.js')
const { startBoxEngine } = await import('../../src/services/host/boxEngine.js')
const { boxFixture } = await import('./boxFixture.mjs')
const fixture = boxFixture(process.env.MERCURY_CONFIG_DIR)
const { createServer } = await import('node:net')
const port = await new Promise<number>(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = (socket.address() as { port: number }).port; socket.close(() => resolve(port)) }) })
const machine = { ...local, name: 'service-fixture', home: fixture.home, engines: [{ kind: 'llamacpp' as const, path: fixture.server, version: 'fixture', port }] }
const recipe = { ...tiny, id: 'fixture', model: 'Fixture/Box', memoryGb: 1, contextPerSlot: 131072, slots: 2 }
try {
  await assert.rejects(() => startBoxEngine(machine, recipe, { destination: fixture.bank, bank: true, confirmed: false, runner: fixture.runner, port }), /Confirm/)
  const started = await startBoxEngine(machine, recipe, { destination: fixture.bank, bank: true, confirmed: true, runner: fixture.runner, port, timeoutMs: 10000, pauseMs: 30 })
  assert.equal(started.state, 'running')
  assert.equal(started.contextPerSlot, 131072)
  assert.ok(existsSync(join(root, 'src/services/host/boxRegistration.ts')), 'own box service registers for every session')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { registerBoxServer } = await import('../../src/services/host/boxRegistration.js')
  const model = 'compat/box-' + machine.name + '/' + recipe.model
  const register = async () => { assert.equal(await registerBoxServer(machine, fixture.runner, signal), model) }
  const bundleAt = process.argv.indexOf('--bundle')
  if (bundleAt >= 0) { const { proveBoxDaemon } = await import('./boxDaemonProof.ts'); await proveBoxDaemon(process.argv[bundleAt + 1]!, process.env.MERCURY_CONFIG_DIR!, model, register) }
  else await register()
  const { namedCompatModelOptions } = await import('../../src/services/providers/openaicompat/compatCatalogue.js')
  const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.js')
  assert.ok(namedCompatModelOptions().some(row => row.value === model))
  assert.equal(getContextWindowForModel(model), 131072)
  const settings = JSON.parse(readFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'settings.json'), 'utf8'))
  assert.equal(settings.compatProvider['box-' + machine.name].dialect, 'llamacpp')
  assert.deepEqual(settings.compatProvider['box-' + machine.name].models, [recipe.model])
  assert.equal(await boxServiceRunning(machine, fixture.runner, signal), true)
  const plist = readFileSync(boxServiceFiles(machine).unit, 'utf8')
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
  assert.ok(plist.includes(fixture.home))
  const linux = boxServiceDocument({ ...machine, os: 'linux' })
  assert.match(linux, /WantedBy=default.target/)
  assert.match(linux, /Restart=on-failure/)
  const windows = boxServiceDocument({ ...machine, os: 'windows', home: 'C:\\Fixture\\Home' })
  assert.match(windows, /LogonTrigger/)
  assert.match(windows, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
  assert.match(windows, /InteractiveToken/)
  const { boxServiceCommand } = await import('../../src/services/host/boxService.js')
  assert.match(boxServiceCommand({ ...machine, os: 'windows', home: 'C:\\Fixture\\Home' }, 'start'), /Register-ScheduledTask.*WindowsIdentity/)
  assert.match(boxServiceCommand({ ...machine, os: 'linux' }, 'start'), /systemctl --user enable/)
  const { runBoxScript } = await import('../../src/services/host/boxExecution.js')
  let windowsCall: { command: string; args: string[] } | undefined
  await runBoxScript({ os: 'windows', target: { host: 'fixture.invalid' } }, 'Get-ScheduledTask', { ...runner, async run(command, args) { windowsCall = { command, args }; return '' } }, signal)
  assert.equal(windowsCall?.command, 'ssh')
  assert.match(windowsCall!.args.at(-1)!, /^powershell.exe -NoProfile -NonInteractive -EncodedCommand /)
  assert.match(Buffer.from(windowsCall!.args.at(-1)!.split(' ').at(-1)!, 'base64').toString('utf16le'), /Get-ScheduledTask/)
  assert.equal(plist, boxServiceDocument(machine))
  const serviceAt = process.argv.indexOf('--services')
  if (serviceAt >= 0) {
    const path = process.argv[serviceAt + 1]!; mkdirSync(path, { recursive: true })
    for (const [os, extension, home] of [['darwin', 'plist', '/fixture/home'], ['linux', 'service', '/fixture/home'], ['windows', 'xml', 'C:\\Fixture\\Home']] as const) writeFileSync(join(path, 'model-host.' + extension), boxServiceDocument({ ...machine, os, home }))
  }
  const { writeBox } = await import('../../src/services/host/boxes.js')
  const { hostCommand } = await import('../../src/commands/host/index.js')
  writeBox(machine)
  const lines: string[] = []
  assert.equal(await hostCommand(['status', machine.name], { runner: fixture.runner, print: text => lines.push(text) }), 0)
  assert.ok(lines.some(line => line.includes('0/2 slots busy') && line.includes('tokens/s')))
  const { compatCallModel } = await import('../../src/services/providers/openaicompat/compatCallModel.js')
  const { createUserMessage } = await import('../../src/utils/messages.js')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
  let reply = ''
  for await (const event of compatCallModel({ messages: [createUserMessage({ content: 'fixture turn' })], tools: [], systemPrompt: asSystemPrompt(['fixture']), thinkingConfig: { type: 'enabled', budgetTokens: 1024 }, signal, options: { model, effortValue: 'max', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } })) if (event.type === 'assistant') reply += JSON.stringify(event.message.content)
  assert.match(reply, /BOX-FIXTURE-READY/)
  const { readBoxService } = await import('../../src/services/host/boxService.js')
  assert.equal(readBoxService(machine.name)!.rateKind, 'whole-turn')
  assert.ok(readBoxService(machine.name)!.tokensPerSecond! > 0)
  if (bundleAt >= 0) {
    const status = await fixture.runner.run('node', [process.argv[bundleAt + 1]!, 'host', 'status', machine.name], signal)
    assert.match(status, /slots busy/)
    const stopped = await fixture.runner.run('node', [process.argv[bundleAt + 1]!, 'host', 'stop', machine.name], signal)
    assert.match(stopped, /Engine stopped/)
    console.log('MERCURY HOST GREEN · built host status and stop use the fixture service')
  } else assert.equal(await hostCommand(['stop', machine.name], { runner: fixture.runner, print: text => lines.push(text) }), 0)
  assert.equal(await boxServiceRunning(machine, fixture.runner, signal), false)
  assert.equal(namedCompatModelOptions().find(row => row.value === model)?.unavailable, 'box service-fixture · engine stopped — /llmhost starts it')
  const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.js')
  const refused = await validateWorkerModelChoice(model, 'session')
  assert.equal(refused.ok, false)
  if (!refused.ok) { assert.equal(refused.reason, 'unreachable:box'); assert.match(refused.detail!, /engine stopped/); assert.ok(!JSON.stringify(refused).includes('needs a key')) }
  await controlBoxService(machine, 'start', fixture.runner, signal)
  assert.equal(await boxServiceRunning(machine, fixture.runner, signal), true)
  await controlBoxService(machine, 'uninstall', fixture.runner, signal)
  assert.equal(existsSync(boxServiceFiles(machine).unit), false)
  const remoteMachine = { ...machine, name: 'remote-fixture', kind: 'ssh' as const, target: { host: 'fixture.invalid' } }
  const remotePort = await new Promise<number>(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const chosen = (socket.address() as { port: number }).port; socket.close(() => resolve(chosen)) }) })
  await startBoxEngine(remoteMachine, recipe, { destination: fixture.bank, bank: true, confirmed: true, runner: fixture.runner, port: remotePort, timeoutMs: 10000, pauseMs: 30 })
  const tunnelHome = { ...machine, name: 'link-fixture' }
  const remoteModel = await registerBoxServer(remoteMachine, fixture.runner, signal, tunnelHome)
  assert.equal(remoteModel, 'compat/box-remote-fixture/Fixture/Box')
  assert.match(readFileSync(boxServiceFiles(tunnelHome).script, 'utf8'), /ExitOnForwardFailure/)
  const { stopBoxTunnel } = await import('../../src/services/host/boxRegistration.js')
  await stopBoxTunnel(remoteMachine, fixture.runner, signal, true, tunnelHome)
  await controlBoxService(remoteMachine, 'uninstall', fixture.runner, signal)
  assert.ok(fixture.commands.some((command: any) => command.command === 'ssh'))
  const ollamaPort = await new Promise<number>(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const chosen = (socket.address() as { port: number }).port; socket.close(() => resolve(chosen)) }) })
  const ollamaBox = { ...machine, name: 'ollama-fixture', engines: [{ kind: 'ollama' as const, path: join(fixture.bin, 'ollama'), version: 'fixture', port: ollamaPort }] }
  const ollamaRecipe = BOX_RECIPES.find(row => row.id === 'nemotron35-bolt')!
  const pulled = await startBoxEngine(ollamaBox, ollamaRecipe, { destination: join(fixture.home, 'ollama-bank'), bank: false, confirmed: true, runner: fixture.runner, port: ollamaPort, timeoutMs: 10000, pauseMs: 30 })
  assert.equal(pulled.contextPerSlot, 262144)
  const ollamaModel = await registerBoxServer(ollamaBox, fixture.runner, signal)
  assert.equal(ollamaModel, 'compat/box-ollama-fixture/' + ollamaRecipe.model)
  assert.ok(fixture.commands.some((command: any) => command.args.at(-1)?.includes(' pull ')))
  const ollamaSettings = JSON.parse(readFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'settings.json'), 'utf8'))
  assert.equal(ollamaSettings.compatProvider['box-ollama-fixture'].dialect, 'ollama')
  await controlBoxService(ollamaBox, 'uninstall', fixture.runner, signal)
  console.log('MERCURY HOST GREEN · Ollama pull, private service, automatic load and served window verified on fixture binary')
  console.log('MERCURY HOST GREEN · fixture SSH service and persistent private tunnel register the remote model')
  console.log('MERCURY HOST GREEN · real fixture binary start, served window, stop/restart/uninstall; plist/unit/task pinned')
} finally { await fixture.close() }
