import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installLiveFixture, proofHome, removeProofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'
import type { LocalJSXCommandContext } from '../../src/types/command.js'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'

process.chdir(proofHome)
process.env.NODE_ENV = 'test'
process.env.MERCURY_COORDINATION_MCP = '0'
Object.assign(globalThis, { MACRO: { VERSION: '1.0.0', IS_DEV: false } })
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
setCwdState(proofHome)
setOriginalCwd(proofHome)
setProjectRoot(proofHome)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { readMediaSettings, MEDIA_SERVER_NAME } = await import('../../src/services/media/settings.js')
const { setProcessSessionKit } = await import('../../src/services/mcp/sessionKitPin.js')
assert.equal(setProcessSessionKit({ schema: 1, mcp: [MEDIA_SERVER_NAME], skills: [], invocable: [] }).ok, true)
const { ensureExtensionsLoaded } = await import('../../src/extensions/boot.js')
const { getExtensionMcpServers } = await import('../../src/extensions/load/servers.js')
const { getDefaultAppState } = await import('../../src/state/AppState.js')
const { createStore } = await import('../../src/state/store.js')
const { getMercuryMcpConfigs } = await import('../../src/services/mcp/config.js')
const { isMcpCatalogueMember } = await import('../../src/services/mcp/membership.js')
const { reconnectMcpServerImpl } = await import('../../src/services/mcp/client.js')
const { imageSetupIo } = await import('../../src/commands/imagesetup/imagesetup.js')
const { mediaPullPlan, pullMedia } = await import('../../src/services/media/setup.js')

const store = createStore(getDefaultAppState())
let screenWrites = 0
const setAppState: typeof store.setState = updater => { screenWrites++; store.setState(updater) }
const context = { getAppState: store.getState, setAppState, options: { tools: [], refreshTools: () => store.getState().mcp.tools } } as unknown as LocalJSXCommandContext
const io = imageSetupIo(context)
const sessionServer = async () => (await getMercuryMcpConfigs()).servers[MEDIA_SERVER_NAME]
let client: MCPServerConnection | undefined
try {
  installLiveFixture()
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath } }).error, null)
  await ensureExtensionsLoaded({ cwd: proofHome })
  assert.equal(readMediaSettings().enabled, false)
  assert.equal(getExtensionMcpServers()[MEDIA_SERVER_NAME], undefined)
  assert.equal(await sessionServer(), undefined, 'A session resolves no media server while Local media is off')
  const snapshot = await io.read()
  const plan = mediaPullPlan(snapshot, 'image-one')
  assert.equal(await pullMedia(plan, async () => false, io.pull, () => {}), false)
  assert.equal(readMediaSettings().enabled, false)
  assert.equal(existsSync(join(root, 'called.jsonl')), false)
  await assert.rejects(io.pull(['fail'], () => {}), /digest mismatch/)
  assert.equal(readMediaSettings().enabled, false)
  const controller = new AbortController()
  await assert.rejects(io.pull(['hang'], () => controller.abort(), controller.signal), /Download paused/)
  assert.equal(readMediaSettings().enabled, false)
  await io.pull(['pull-runtime'], () => {})
  assert.equal(readMediaSettings().enabled, false)
  assert.equal(await sessionServer(), undefined)
  assert.equal(screenWrites, 0, 'Nothing reloads while Local media stays off')
  assert.equal(await pullMedia(plan, async () => true, io.pull, () => {}), true)
  assert.equal(readMediaSettings().enabled, true, 'A successful first model pull enables Local media')
  assert.ok(screenWrites > 0, 'The first model pull reloads the extensions')
  const config = await sessionServer()
  assert.ok(config, 'The first model pull puts the media server in the set a session resolves')
  assert.equal(isMcpCatalogueMember(MEDIA_SERVER_NAME), true)
  client = (await reconnectMcpServerImpl(MEDIA_SERVER_NAME, config)).client
  assert.equal(client.type, 'connected')
  if (client.type !== 'connected') throw new Error('Missing live media client')
  const list = await client.client.callTool({ name: 'media_models', arguments: {} })
  assert.equal(list.isError ?? false, false)
  const data = JSON.parse((list.content as Array<{ text: string }>)[0]!.text)
  assert.equal(data.models.find((model: { model: string }) => model.model === 'image-one').installed, true)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false, 'Enabling the MCP must not load weights')
  const writes = screenWrites
  await io.pull(['pull-model', 'image-two'], () => {})
  assert.equal(screenWrites, writes, 'A later pull reloads nothing')
  assert.deepEqual(await sessionServer(), config, 'A later pull leaves the server a session resolves unchanged')
  console.log('media live setup: decline, failure, pause and runtime-only stay off; first model enables, joins the set a session resolves, connects and lists the model; later pulls reload nothing; no weights loaded')
} finally {
  if (client?.type === 'connected') await client.cleanup()
  await stopFixtureEngine()
  removeProofHome()
}
