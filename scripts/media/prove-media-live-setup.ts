import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installLiveFixture, proofHome, removeProofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'
import type { LocalJSXCommandContext } from '../../src/commands/catalogue/command.js'
import type { MCPServerConnection } from '../../src/integrations/mcp-shapes/mcpServerRecords.js'

process.chdir(proofHome)
process.env.NODE_ENV = 'test'
process.env.MERCURY_COORDINATION_MCP = '0'
Object.assign(globalThis, { MACRO: { VERSION: '1.0.0', IS_DEV: false } })
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.js')
setCwdState(proofHome)
setOriginalCwd(proofHome)
setProjectRoot(proofHome)
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/platform/settings/settings.js')
const { readMediaSettings, MEDIA_SERVER_NAME } = await import('../../src/integrations/media/settings.js')
const { setProcessSessionKit } = await import('../../src/integrations/mcp/sessionKitPin.js')
assert.equal(setProcessSessionKit({ schema: 1, mcp: [MEDIA_SERVER_NAME], skills: [], invocable: [] }).ok, true)
const { ensureExtensionsLoaded } = await import('../../src/integrations/extensions/boot.js')
const { getExtensionMcpServers } = await import('../../src/integrations/extensions/load/servers.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppState.js')
const { createStore } = await import('../../src/platform/primitives/store.js')
const { getMercuryMcpConfigs } = await import('../../src/integrations/mcp/serverConfigs.js')
const { isMcpCatalogueMember } = await import('../../src/integrations/mcp/membership.js')
const { reconnectMcpServerImpl } = await import('../../src/integrations/mcp/client.js')
const { imageSetupIo } = await import('../../src/commands/imagesetup/imagesetup.js')
const { mediaPullPlan, pullMedia } = await import('../../src/integrations/media/setup.js')

const store = createStore(getDefaultAppState())
let screenWrites = 0
const setAppState: typeof store.setState = updater => { screenWrites++; store.setState(updater) }
const context = { getAppState: store.getState, setAppState, options: { tools: [], refreshTools: () => store.getState().mcp.tools } } as unknown as LocalJSXCommandContext
const io = imageSetupIo(context)
const sessionServer = async () => (await getMercuryMcpConfigs()).servers[MEDIA_SERVER_NAME]
let client: MCPServerConnection | undefined
try {
  installLiveFixture()
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath } }).error, null, 'writing the media root and serverPath to the user settings failed; see updateSettingsForSource in src/platform/settings/settings.ts')
  await ensureExtensionsLoaded({ cwd: proofHome })
  assert.equal(readMediaSettings().enabled, false, 'Local media must start off; see readMediaSettings in src/integrations/media/settings.ts')
  assert.equal(getExtensionMcpServers()[MEDIA_SERVER_NAME], undefined, 'the media server must not be among the extension servers while Local media is off; see src/integrations/extensions/load/servers.ts')
  assert.equal(await sessionServer(), undefined, 'A session resolves no media server while Local media is off')
  const snapshot = await io.read()
  const plan = mediaPullPlan(snapshot, 'image-one')
  assert.equal(await pullMedia(plan, async () => false, io.pull, () => {}), false, 'pullMedia in src/integrations/media/setup.ts must return false and pull nothing when consent is declined')
  assert.equal(readMediaSettings().enabled, false, 'a declined pull must leave Local media off; see imageSetupIo in src/commands/imagesetup/imagesetup.tsx')
  assert.equal(existsSync(join(root, 'called.jsonl')), false, 'a declined pull must not run the setup runner; see pullMedia in src/integrations/media/setup.ts')
  await assert.rejects(io.pull(['fail'], () => {}), /digest mismatch/, 'a failed pull must reject with the digest mismatch error; see io.pull in imageSetupIo, src/commands/imagesetup/imagesetup.tsx')
  assert.equal(readMediaSettings().enabled, false, 'a failed pull must leave Local media off; see imageSetupIo in src/commands/imagesetup/imagesetup.tsx')
  const controller = new AbortController()
  await assert.rejects(io.pull(['hang'], () => controller.abort(), controller.signal), /Download paused/, 'an aborted pull must reject with Download paused; see src/integrations/media/setup.ts')
  assert.equal(readMediaSettings().enabled, false, 'a paused pull must leave Local media off; see imageSetupIo in src/commands/imagesetup/imagesetup.tsx')
  await io.pull(['pull-runtime'], () => {})
  assert.equal(readMediaSettings().enabled, false, 'a runtime-only pull must leave Local media off; imageSetupIo in src/commands/imagesetup/imagesetup.tsx enables it only for a model (newlyEnabled)')
  assert.equal(await sessionServer(), undefined, 'a runtime-only pull must not put the media server in the set a session resolves; see getMercuryMcpConfigs in src/integrations/mcp/serverConfigs.ts')
  assert.equal(screenWrites, 0, 'Nothing reloads while Local media stays off')
  assert.equal(await pullMedia(plan, async () => true, io.pull, () => {}), true, 'pullMedia in src/integrations/media/setup.ts must return true after a consented model pull')
  assert.equal(readMediaSettings().enabled, true, 'A successful first model pull enables Local media')
  assert.ok(screenWrites > 0, 'The first model pull reloads the extensions')
  const config = await sessionServer()
  assert.ok(config, 'The first model pull puts the media server in the set a session resolves')
  assert.equal(isMcpCatalogueMember(MEDIA_SERVER_NAME), true, 'isMcpCatalogueMember in src/integrations/mcp/membership.ts must count the media server as a member once Local media is on')
  client = (await reconnectMcpServerImpl(MEDIA_SERVER_NAME, config)).client
  assert.equal(client.type, 'connected', 'reconnectMcpServerImpl in src/integrations/mcp/client.ts must connect the media server')
  if (client.type !== 'connected') throw new Error('Missing live media client')
  const list = await client.client.callTool({ name: 'media_models', arguments: {} })
  assert.equal(list.isError ?? false, false, 'the media_models tool of the media server returned an error')
  const data = JSON.parse((list.content as Array<{ text: string }>)[0]!.text)
  assert.equal(data.models.find((model: { model: string }) => model.model === 'image-one').installed, true, 'media_models must list image-one as installed after its pull')
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
