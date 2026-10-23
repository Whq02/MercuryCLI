import assert from 'node:assert/strict'
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.ts'

assert(process.argv.includes('--gui'), 'Pass --gui explicitly; this proof opens a FilmCraft window')
const root = resolve(import.meta.dir, '../..'), scratch = resolve(process.argv[2] ?? '')
assert(process.argv[2] && !scratch.startsWith(root), 'Pass the isolated directory used by prove-filmcraft.ts')
const delivered = join(scratch, 'extension'), dataDir = join(scratch, 'data'), project = join(scratch, 'edited.fcproj')
await readFile(project)
await cp(join(root, 'src/extensions/bundled/filmcraft'), delivered, { recursive: true })
await cp(join(root, 'src/extensions/bundled/shared'), join(delivered, 'shared'), { recursive: true })
const { adapter } = await import(pathToFileURL(join(delivered, 'server/install.mjs')).href)
const { checkInstall } = await import(pathToFileURL(join(delivered, 'shared/install.mjs')).href)
const { controlSession } = await import(pathToFileURL(join(delivered, 'shared/control.mjs')).href)
const checked = await checkInstall(adapter, { dataDir }); assert.equal(checked.state, 'installed')
await rename(join(dataDir, 'app-data'), join(scratch, `previous-proof-app-data-${Date.now()}`)).catch((error: any) => { if (error.code !== 'ENOENT') throw error })
const reservation = createServer()
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = (reservation.address() as { port: number }).port
await new Promise<void>(resolve => reservation.close(() => resolve()))
const endpoint = `127.0.0.1:${port}`
const environment = { ...process.env, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'config'), TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'), MERCURY_EXTENSION_DATA: dataDir }
for (const path of [environment.HOME, environment.XDG_CONFIG_HOME, environment.TMPDIR]) await mkdir(path, { recursive: true })
const events: unknown[] = []
function decode(response: any): any {
  const text = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
  try { return JSON.parse(text) } catch { return text }
}
async function connect() {
  const client = new Client({ name: 'filmcraft-gui-proof', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(delivered, 'server/bridge.mjs')], env: environment as Record<string, string>, stderr: 'pipe' })
  await client.connect(transport)
  return client
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}, failure = false) {
  const response = await client.callTool({ name, arguments: args })
  events.push({ name, args, response: { ...response, content: response.content.map((c: any) => c.type === 'image' ? { type: 'image', mimeType: c.mimeType, bytes: c.data.length } : c) } })
  await writeFile(join(scratch, 'gui-events.json'), JSON.stringify(events, null, 2))
  assert.equal(response.isError === true, failure, JSON.stringify(response).slice(0, 600))
  return response
}
async function screenshot(client: Client, name: string) {
  const response = await call(client, 'ui_screenshot')
  const image = response.content.find((c: any) => c.type === 'image') as any
  assert(image?.data, 'App-native screenshot must return image bytes')
  await writeFile(join(scratch, name), Buffer.from(image.data, 'base64'))
}
const clips = (sequence: any) => sequence.video.reduce((count: number, track: any) => count + track.items.length, 0)
let client = await connect(), owned = false
try {
  const started = decode(await call(client, 'craft_connect', { mode: 'launch', endpoint, project }))
  console.log(started); owned = true
  const status = decode(await call(client, 'craft_status'))
  const pid = status.attached.process.pid
  const tools = await client.listTools()
  assert.equal(tools.tools.length, 20)
  const commands = decode(await call(client, 'command_list'))
  await writeFile(join(scratch, 'gui-tools.json'), JSON.stringify(tools, null, 2))
  console.log(`Attached GUI: ${tools.tools.length - 3} upstream tools, ${commands.length} commands`)
  await screenshot(client, 'filmcraft-before.png')
  const before = decode(await call(client, 'sequence_inspect'))
  await call(client, 'command_run', { id: 'sequence.addEdit', params: { seconds: 0.5 } })
  const edited = decode(await call(client, 'sequence_inspect'))
  assert.equal(clips(edited), clips(before) + 1)
  await screenshot(client, 'filmcraft-after-mcp.png')
  await call(client, 'ui_key', { key: 'Cmd+Z' })
  const afterGui = decode(await call(client, 'sequence_inspect'))
  assert.equal(clips(afterGui), clips(before), 'GUI Undo must undo the edit made through MCP')
  const uiBefore = decode(await call(client, 'ui_inspect'))
  const nextTool = uiBefore.ui.tool === 'Razor' ? 'Selection' : 'Razor'
  await call(client, 'ui_click', { id: `tools.${nextTool}` })
  const ui = decode(await call(client, 'ui_inspect'))
  assert.equal(ui.ui.tool, nextTool)
  await screenshot(client, 'filmcraft-after-gui.png')
  await call(client, 'command_run', { id: 'file.exportMedia', params: { path: join(scratch, 'failed-export.mp4'), format: 'not-a-format', wait: true } }, true)
  await client.close()
  process.kill(pid, 0)
  client = await connect()
  await call(client, 'craft_connect', { mode: 'attach', endpoint, project })
  const reattached = decode(await call(client, 'craft_status'))
  assert.equal(reattached.attached.process.pid, pid)
  assert.equal(clips(decode(await call(client, 'sequence_inspect'))), clips(before))
  await screenshot(client, 'filmcraft-reattached.png')
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGSTOP')
    try {
      await assert.rejects(client.callTool({ name: 'command_run', arguments: { id: 'sequence.addEdit', params: { seconds: 0.75 } } }, { timeout: 250 }), /timed out|timeout/i)
    } finally { process.kill(pid, 'SIGCONT') }
    const recovered = decode(await call(client, 'sequence_inspect'))
    assert.equal(clips(recovered), clips(before), 'An edit cancelled while verifying attachment must not execute later')
    await writeFile(join(scratch, 'timeout-recovery.json'), JSON.stringify({ timeout: true, blindRetries: 0, clipsBefore: clips(before), clipsAfterInspection: clips(recovered) }, null, 2))
  }
  await client.close()
  process.kill(pid, 0)
  await writeFile(join(scratch, 'gui-verdict.json'), JSON.stringify({ tools: tools.tools.length, commands: commands.length, pid, clipsBefore: clips(before), clipsAfterMcp: clips(edited), clipsAfterGui: clips(afterGui), survivesMcpClose: true, sameProcessOnAttach: true }, null, 2))
  console.log('PASS: same-canvas MCP edit / GUI Undo and click / screenshot / same-process reattachment / MCP close leaves GUI alive')
} finally {
  await client.close().catch(() => {})
  if (owned) { const control = controlSession(endpoint); try { await control.request('app.quit') } finally { control.close() } }
}
