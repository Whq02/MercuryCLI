#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, writeFile, stat, access } from 'node:fs/promises'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const repo = resolve(import.meta.dir, '../..')
const args = process.argv.slice(2)
const rootArg = args[args.indexOf('--root') + 1]
assert.ok(args.includes('--root') && rootArg && isAbsolute(rootArg), 'Choose --root as a new absolute scratch directory; never a photo library or account configuration.')
const root = resolve(rootArg)
assert.ok(![repo, dirname(repo), process.env.HOME, process.env.USERPROFILE].includes(root), 'Use an isolated scratch directory.')
const modes = ['--install', '--check', '--headless', '--gui'].filter(flag => args.includes(flag))
assert.equal(modes.length, 1, 'Choose exactly one proof mode.')
assert.ok(args.every((arg, i) => ['--root', ...modes].includes(arg) || args[i - 1] === '--root'), 'Unknown argument')
await mkdir(root, { recursive: true, mode: 0o700 })
const { adapter, privateEnvironment } = await import(pathToFileURL(join(repo, 'src/extensions/bundled/lightcraft/server/install.mjs')).href)
const { planInstall, installPinned, checkInstall } = await import(pathToFileURL(join(repo, 'src/extensions/bundled/shared/install.mjs')).href)
const dataDir = join(root, 'data')
const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), ...privateEnvironment(root) } as Record<string, string>
await mkdir(env.HOME!, { recursive: true, mode: 0o700 })
for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'LIGHTCRAFT_CONFIG_DIR', 'TMPDIR', 'TMP', 'TEMP']) process.env[key] = env[key]
const work = modes[0] === '--gui' || modes[0] === '--headless' ? await mkdtemp(join(root, `${modes[0].slice(2)}-`)) : root
const evidence: Record<string, any> = { mode: modes[0], platform: process.platform, arch: process.arch, workingRoot: work }
let activeClient: Client | undefined
let gui: ReturnType<typeof import('node:child_process').spawn> | undefined
let guiStderr = ''
async function stopGui() {
  if (gui?.pid && gui.exitCode === null) {
    const exited = once(gui, 'exit')
    gui.kill('SIGTERM')
    await exited
  }
  gui = undefined
}
function data(result: any): any {
  assert.notEqual(result.isError, true, JSON.stringify(result))
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content.find((part: any) => part.type === 'text')?.text
  if (text === 'ok') return text
  return JSON.parse(text)
}
async function connect(command: string, commandArgs: string[], extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command, args: commandArgs, env: { ...env, ...extraEnv }, stderr: 'pipe', maxBufferSize: 64 * 1024 * 1024 })
  transport.stderr?.on('data', (bytes: Buffer) => { guiStderr += bytes.toString() })
  const client = new Client({ name: 'mercury-lightcraft-proof', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  activeClient = client
  assert.deepEqual(client.getServerVersion(), { name: 'lightcraft', title: 'LightCraft', version: '0.13.0' })
  evidence.server = client.getServerVersion()
  const tools = await client.listTools()
  evidence.tools = tools
  evidence.toolCount = tools.tools.length
  const commands = data(await client.callTool({ name: 'command_list', arguments: {} }))
  evidence.commandCount = Array.isArray(commands) ? commands.length : commands.commands?.length
  evidence.commands = commands
  return client
}
async function connectBridge(endpoint: string, library: string) {
  const delivered = join(work, 'extension')
  await cp(join(repo, 'src/extensions/bundled/lightcraft'), delivered, { recursive: true })
  await cp(join(repo, 'src/extensions/bundled/shared'), join(delivered, 'shared'), { recursive: true })
  const transport = new StdioClientTransport({ command: 'node', args: [join(delivered, 'server/bridge.mjs')], env: { ...env, MERCURY_EXTENSION_DATA: dataDir }, stderr: 'pipe', maxBufferSize: 64 * 1024 * 1024 })
  transport.stderr?.on('data', (bytes: Buffer) => { guiStderr += bytes.toString() })
  const client = new Client({ name: 'mercury-lightcraft-bridge-proof', version: '1' }, { capabilities: {} })
  await client.connect(transport)
  activeClient = client
  const attached = await client.callTool({ name: 'craft_connect', arguments: { mode: 'attach', endpoint, library } })
  assert.notEqual(attached.isError, true, JSON.stringify(attached))
  evidence.bridgeAttach = attached
  const tools = await client.listTools()
  evidence.bridgeTools = tools
  assert.equal(tools.tools.length, evidence.toolCount + 3)
  assert.deepEqual(tools.tools.slice(3).map(tool => tool.name), evidence.tools.tools.map((tool: any) => tool.name))
  evidence.resources = await client.listResources()
  assert.ok(evidence.resources.resources.length > 0)
  await client.readResource({ uri: 'lightcraft://document' })
  return client
}
async function disconnectedCall(cli: string) {
  const requests: unknown[] = []
  const server = createServer(socket => {
    let buffer = ''
    socket.on('data', bytes => {
      buffer += bytes.toString()
      if (!buffer.includes('\n')) return
      requests.push(JSON.parse(buffer.split('\n')[0]!))
      socket.destroy()
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const endpoint = `127.0.0.1:${(server.address() as { port: number }).port}`
  const client = new Client({ name: 'lightcraft-disconnect-proof', version: '1' }, { capabilities: {} })
  const transport = new StdioClientTransport({ command: cli, args: ['mcp', '--connect', endpoint], env, stderr: 'pipe' })
  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'command_run', arguments: { id: 'develop.set', params: { values: { 'light.exposure': 0.7 } } } })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /outcome is unknown/i)
    assert.equal(requests.length, 1, 'The released CLI must not replay an unknown-outcome edit.')
    evidence.disconnect = { requests, result }
  } finally {
    await client.close()
    await new Promise<void>(done => server.close(() => done()))
  }
}
async function fixture() {
  const pixels = Buffer.alloc(96 * 64 * 3)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
    const i = (y * 96 + x) * 3
    pixels[i] = 40 + x; pixels[i + 1] = 40 + y; pixels[i + 2] = 60
  }
  const path = join(work, 'fixture.png')
  await sharp(pixels, { raw: { width: 96, height: 64, channels: 3 } }).png().toFile(path)
  return path
}
async function call(client: Client, name: string, arguments_: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: arguments_ })
  evidence[name] = result
  return data(result)
}
async function develop(client: Client, label: string) {
  await call(client, 'doc_inspect')
  const imported = await call(client, 'import', { paths: [await fixture()], mode: 'copy' })
  assert.equal(imported.imported.length, 1)
  const id = imported.imported[0]
  const queried = await call(client, 'query_photos')
  const photos = Array.isArray(queried) ? queried : queried.photos ?? queried.items
  assert.ok(photos.some((photo: any) => photo.id === id && photo.fileName === 'fixture.png'))
  await call(client, 'select_photos', { ids: [id] })
  await call(client, 'list_controls', { section: 'light' })
  const output = join(work, `${label}-output`)
  await mkdir(output, { mode: 0o700 })
  await call(client, 'export', { id, path: join(output, 'baseline.png'), format: 'png', longEdge: 96 })
  await call(client, 'set_develop', { id, values: { 'light.exposure': 0.7 } })
  const settings = await call(client, 'get_develop', { id })
  assert.equal(settings.light.exposure, 0.7)
  const rendered = await client.callTool({ name: 'render_photo', arguments: { id, size: 96 } })
  assert.notEqual(rendered.isError, true)
  await call(client, 'export', { id, path: join(output, 'developed.png'), format: 'png', longEdge: 96 })
  const before = await sharp(join(output, 'baseline.png')).raw().toBuffer({ resolveWithObject: true })
  const after = await sharp(join(output, 'developed.png')).raw().toBuffer({ resolveWithObject: true })
  assert.equal(after.info.width, 96); assert.equal(after.info.height, 64)
  const mean = (bytes: Buffer) => bytes.reduce((sum, n) => sum + n, 0) / bytes.length
  assert.ok(mean(after.data) > mean(before.data))
  evidence.pixels = { before: mean(before.data), after: mean(after.data), width: after.info.width, height: after.info.height }
  const artifact = join(root, `${label}-developed.png`)
  await cp(join(output, 'developed.png'), artifact)
  evidence.export = { path: artifact, bytes: (await stat(artifact)).size }
  await assert.rejects(client.callTool({ name: 'query_photos', arguments: { unknownArgument: true } }))
  const failure = await client.callTool({ name: 'export', arguments: { id, path: join(await fixture(), 'impossible.png') } })
  assert.equal(failure.isError, true)
  evidence.exportFailure = failure
  return id
}
try {
  evidence.plan = await planInstall(adapter, { dataDir })
  if (modes[0] === '--install') {
    await assert.rejects(access(dataDir), 'The install proof requires an empty cache.')
    let asks = 0
    const installation = await installPinned(adapter, { dataDir, authorize: async () => { asks++; return true }, onProgress: (received: number, total: number, archive: string) => { if (received === total) console.error(`${archive}: ${received} bytes downloaded`) } })
    assert.equal(asks, 1)
    evidence.installation = installation
    evidence.offline = await checkInstall(adapter, { dataDir })
    assert.equal(evidence.offline.state, 'installed')
    const reused = await installPinned(adapter, { dataDir, authorize: async () => { throw new Error('A valid existing installation must not ask or download again.') } })
    assert.equal(reused.reused, true)
    evidence.reused = reused.reused
    evidence.version = execFileSync(installation.cli, ['--version'], { env, encoding: 'utf8' }).trim()
    assert.equal(evidence.version, 'lightcraft-cli 0.13.0')
    if (process.platform === 'darwin') {
      const app = installation.gui.slice(0, installation.gui.indexOf('.app') + 4)
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', installation.cli], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      evidence.signature = { desktop: 'codesign exit 0', cli: 'codesign exit 0', gatekeeper: 'spctl exit 0' }
      evidence.guiVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
      assert.equal(evidence.guiVersion, '0.13.0')
    } else if (process.platform === 'win32') {
      evidence.signature = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s=@($env:LIGHTCRAFT_PROOF_GUI,$env:LIGHTCRAFT_PROOF_CLI) | ForEach-Object { Get-AuthenticodeSignature -LiteralPath $_ }; $s | Select-Object Path,Status,StatusMessage,SignerCertificate | ConvertTo-Json -Depth 4; if(@($s | Where-Object { $_.Status -ne "Valid" }).Count){exit 1}'], { env: { ...env, LIGHTCRAFT_PROOF_GUI: installation.gui, LIGHTCRAFT_PROOF_CLI: installation.cli }, encoding: 'utf8' })
    }
  } else {
    const checked = await checkInstall(adapter, { dataDir })
    assert.equal(checked.state, 'installed', JSON.stringify(checked))
    const installation = checked.installation
    evidence.installation = installation
    if (modes[0] === '--headless') {
      const client = await connect(installation.cli, ['mcp', '--library', join(work, 'library')])
      assert.equal(evidence.toolCount, 388)
      assert.equal(evidence.commandCount, 371)
      await develop(client, 'headless')
      const noWindow = await client.callTool({ name: 'screenshot', arguments: {} })
      assert.equal(noWindow.isError, true)
      evidence.noWindow = noWindow
      await client.close(); activeClient = undefined
      await disconnectedCall(installation.cli)
    } else if (modes[0] === '--gui') {
      const reservation = createServer()
      await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done))
      const port = (reservation.address() as { port: number }).port
      await new Promise<void>(done => reservation.close(() => done()))
      const endpoint = `127.0.0.1:${port}`
      const input = { mode: 'launch', library: join(work, 'library') }
      await mkdir(input.library, { recursive: true, mode: 0o700 })
      const context = { installation, endpoint, dataDir, input }
      gui = await adapter.launch(context)
      gui!.stderr?.on('data', (bytes: Buffer) => { guiStderr += bytes.toString() })
      let attached: any
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        if (gui!.exitCode !== null) throw new Error(`LightCraft exited before attachment: ${gui!.exitCode}`)
        try { attached = await adapter.probe(context); break } catch (error) {
          if (Date.now() + 250 >= deadline) throw error
          await new Promise(done => setTimeout(done, 250))
        }
      }
      assert.ok(attached)
      evidence.attached = attached
      const upstream = adapter.upstream(context)
      const direct = await connect(upstream.command, upstream.args, upstream.env)
      await direct.close(); activeClient = undefined
      const client = await connectBridge(endpoint, input.library)
      const photoId = await develop(client, 'gui')
      evidence.guiState = await call(client, 'ui_inspect')
      evidence.widgets = await call(client, 'list_widgets', { filter: 'light.exposure' })
      const widgets = Array.isArray(evidence.widgets) ? evidence.widgets : evidence.widgets.widgets
      assert.ok(widgets?.length, 'Exposure widget must be discovered from the actual UI.')
      const slider = widgets.find((widget: any) => widget.id === 'slider:light.exposure' && widget.rect?.[2] > 60)
      assert.ok(slider, JSON.stringify(widgets))
      const [x, y, width, height] = slider.rect
      await call(client, 'click', { x: x + width * 0.25, y: y + height / 2 })
      let afterClick: any
      for (let attempt = 0; attempt < 20; attempt++) {
        afterClick = await call(client, 'get_develop', { id: photoId })
        if (afterClick.light.exposure !== 0.7) break
        await new Promise(done => setTimeout(done, 100))
      }
      assert.ok(Math.abs(afterClick.light.exposure - -2.5) < 0.05, 'A quarter-track GUI click must set exposure to -2.5 on the same photo read through MCP.')
      evidence.sameCanvas = { widget: slider.id, guiExposure: afterClick.light.exposure }
      await call(client, 'set_develop', { id: photoId, values: { 'light.exposure': 0.7 } })
      const screenshot = await client.callTool({ name: 'ui_screenshot', arguments: {} })
      assert.notEqual(screenshot.isError, true)
      const image = (screenshot.content as Array<{ type: string; data?: string; mimeType?: string }>).find(part => part.type === 'image')
      assert.ok(image?.data)
      evidence.frame = join(root, 'lightcraft-window.png')
      await writeFile(evidence.frame, Buffer.from(image.data, 'base64'))
      assert.doesNotMatch(guiStderr, /rendering headlessly/i, 'A fallback render is not native-window acceptance.')
      await client.close(); activeClient = undefined
      process.kill(gui!.pid!, 0)
      const again = await adapter.probe({ ...context, input: { ...input, mode: 'attach' } })
      assert.equal(again.process.pid, attached.process.pid)
      assert.equal(again.project, attached.project)
      evidence.reattached = again
      const reattachedClient = await connectBridge(endpoint, input.library)
      await call(reattachedClient, 'get_develop', { id: photoId })
      await reattachedClient.close(); activeClient = undefined
      await assert.rejects(adapter.probe({ ...context, input: { ...input, library: root } }), /different library/)
      await assert.rejects(adapter.verify({ ...context, attached: { ...attached, process: { ...attached.process, pid: -1 } } }), /process changed/)
      await assert.rejects(adapter.launch(context), /already running/)
      evidence.noDuplicate = { pid: gui!.pid, sameLibrary: again.project }
      evidence.mismatchRefused = true
      await stopGui()
      const noControlLibrary = join(work, 'ordinary-library')
      const ordinaryEnv = { ...env, ...privateEnvironment(dataDir) }
      delete ordinaryEnv.LIGHTCRAFT_CONTROL_PORT
      gui = spawn(installation.gui, ['--library', noControlLibrary], { env: ordinaryEnv, stdio: ['ignore', 'ignore', 'pipe'] })
      await new Promise<void>((ready, reject) => {
        const timer = setTimeout(() => reject(new Error('The ordinary LightCraft window did not initialize.')), 30000)
        const observe = (bytes: Buffer) => {
          const line = bytes.toString(); guiStderr += line
          if (line.includes('library ') && line.includes('photos')) { clearTimeout(timer); gui!.stderr!.off('data', observe); ready() }
        }
        gui!.stderr!.on('data', observe)
        gui!.once('error', error => { clearTimeout(timer); reject(error) })
        gui!.once('exit', () => { clearTimeout(timer); reject(new Error('Ordinary LightCraft exited before its library was ready.')) })
      })
      await assert.rejects(adapter.launch({ ...context, input: { ...input, library: noControlLibrary } }), /already running.*control port/)
      process.kill(gui!.pid!, 0)
      evidence.ordinaryWindowPreserved = { pid: gui!.pid, library: noControlLibrary, remedy: 'Save your work and enable its control port, then attach.' }
    }
  }
  console.log(JSON.stringify({ mode: modes[0], toolCount: evidence.toolCount, commandCount: evidence.commandCount, pixels: evidence.pixels, frame: evidence.frame, evidence: join(root, `${modes[0].slice(2)}.json`) }))
} finally {
  await activeClient?.close()
  await stopGui()
  await writeFile(join(root, `${modes[0].slice(2)}.json`), JSON.stringify(evidence, null, 2))
  await writeFile(join(root, `${modes[0].slice(2)}.stderr.log`), guiStderr)
}
