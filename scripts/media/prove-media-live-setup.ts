import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'
import type { LocalJSXCommandContext } from '../../src/types/command.js'

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
const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.js')
const { createStore } = await import('../../src/state/store.js')
const { useManageMCPConnections } = await import('../../src/services/mcp/useManageMCPConnections.js')
const { imageSetupIo } = await import('../../src/commands/imagesetup/imagesetup.js')
const { mediaPullPlan, pullMedia } = await import('../../src/services/media/setup.js')
const { render } = await import('../../src/ink.js')

const store = createStore(getDefaultAppState())
const context = { getAppState: store.getState, setAppState: store.setState, options: { tools: [], refreshTools: () => store.getState().mcp.tools } } as unknown as LocalJSXCommandContext
const io = imageSetupIo(context)
let mounted!: () => void
const ready = new Promise<void>(resolve => { mounted = resolve })
function Connections(): React.ReactNode {
  useManageMCPConnections(undefined)
  React.useEffect(mounted, [])
  return null
}
function connected(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Media server did not connect in the live session')) }, 10000)
    const check = (): void => {
      const client = store.getState().mcp.clients.find(client => client.name === MEDIA_SERVER_NAME)
      if (client?.type === 'connected' && store.getState().mcp.tools.some(tool => tool.mcpInfo?.serverName === MEDIA_SERVER_NAME)) {
        clearTimeout(timer); off(); resolve()
      } else if (client?.type === 'failed') { clearTimeout(timer); off(); reject(new Error(JSON.stringify(client))) }
    }
    const off = store.subscribe(check)
    check()
  })
}
const input = new PassThrough()
const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 })
output.resume()
let instance: Awaited<ReturnType<typeof render>> | undefined
try {
  installLiveFixture()
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath } }).error, null)
  await ensureExtensionsLoaded({ cwd: proofHome })
  assert.equal(readMediaSettings().enabled, false)
  assert.equal(getExtensionMcpServers()[MEDIA_SERVER_NAME], undefined)
  instance = await render(React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(Connections)), { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false })
  await ready
  assert.equal(store.getState().mcp.clients.some(client => client.name === MEDIA_SERVER_NAME), false)
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
  assert.equal(await pullMedia(plan, async () => true, io.pull, () => {}), true)
  assert.equal(readMediaSettings().enabled, true, 'A successful first model pull enables Local media')
  await connected()
  const client = store.getState().mcp.clients.find(client => client.name === MEDIA_SERVER_NAME)!
  assert.equal(client.type, 'connected')
  if (client.type !== 'connected') throw new Error('Missing live media client')
  const list = await client.client.callTool({ name: 'media_models', arguments: {} })
  assert.equal(list.isError ?? false, false)
  const data = JSON.parse((list.content as Array<{ text: string }>)[0]!.text)
  assert.equal(data.models.find((model: { model: string }) => model.model === 'image-one').installed, true)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false, 'Enabling the MCP must not load weights')
  const key = store.getState().mcp.extensionReconnectKey
  await io.pull(['pull-model', 'image-two'], () => {})
  assert.equal(store.getState().mcp.extensionReconnectKey, key, 'A later pull keeps the connection')
  assert.equal(store.getState().mcp.clients.find(client => client.name === MEDIA_SERVER_NAME), client)
  console.log('media live setup: decline, failure, pause and runtime-only stay off; first model enables and connects; later pulls keep the client; no weights loaded')
} finally {
  instance?.unmount()
  instance?.cleanup()
  for (const client of store.getState().mcp.clients) if (client.type === 'connected') await client.cleanup()
  input.destroy()
  output.destroy()
  await stopFixtureEngine()
  rmSync(proofHome, { recursive: true, force: true })
}
