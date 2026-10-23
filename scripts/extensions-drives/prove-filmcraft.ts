import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.ts'
import sharp from 'sharp'

const exec = promisify(execFile)
const root = resolve(import.meta.dir, '../..')
const scratch = process.argv[2] && resolve(process.argv[2])
assert(scratch && !scratch.startsWith(root), 'Pass an isolated absolute proof directory outside the repository')
const delivered = join(scratch, 'extension'), dataDir = join(scratch, 'data')
await mkdir(scratch, { recursive: true })
await cp(join(root, 'src/extensions/bundled/filmcraft'), delivered, { recursive: true })
await cp(join(root, 'src/extensions/bundled/shared'), join(delivered, 'shared'), { recursive: true })
const { adapter } = await import(pathToFileURL(join(delivered, 'server/install.mjs')).href)
const { checkInstall, installPinned } = await import(pathToFileURL(join(delivered, 'shared/install.mjs')).href)
let asks = 0
const installation = await installPinned(adapter, { dataDir, authorize: async (plan: unknown) => { asks++; console.log(JSON.stringify(plan)); return true }, onProgress: (received: number, total: number, archive: string) => { if (received === total) console.log(`${archive}: ${received} bytes downloaded`) } })
console.log(`Installed: ${installation.cli}`)
assert.equal((await checkInstall(adapter, { dataDir })).state, 'installed')
assert((await installPinned(adapter, { dataDir, authorize: () => { throw new Error('Reuse must not ask') } })).reused)
const environment = { ...process.env, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'config'), FILMCRAFT_DATA_DIR: join(scratch, 'app-data'), TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp') }
for (const key of ['HOME', 'XDG_CONFIG_HOME', 'FILMCRAFT_DATA_DIR', 'TMPDIR'] as const) await mkdir(environment[key]!, { recursive: true })
const version = await exec(installation.cli, ['--version'], { env: environment })
assert.match(version.stdout, /0\.12\.0/)
console.log(version.stdout.trim())
const client = new Client({ name: 'filmcraft-install-proof', version: '1.0.0' })
const transport = new StdioClientTransport({ command: installation.cli, args: ['mcp'], env: environment as Record<string, string>, stderr: 'pipe' })
await client.connect(transport)
try {
  const tools = await client.listTools()
  assert.equal(tools.tools.length, 17)
  const commands = await client.callTool({ name: 'command_list', arguments: {} })
  assert(!commands.isError)
  const texts = commands.content.filter((c: { type: string }) => c.type === 'text').map((c: { text?: string }) => c.text).join('\n')
  const parsed = JSON.parse(texts)
  const entries = Array.isArray(parsed) ? parsed : parsed.commands
  assert.equal(entries.length, 701)
  await writeFile(join(scratch, 'mcp-tools.json'), JSON.stringify(tools, null, 2))
  await writeFile(join(scratch, 'mcp-commands.json'), texts)
  await writeFile(join(scratch, 'install-receipt.json'), JSON.stringify({ installation, asks, version: version.stdout, server: client.getServerVersion(), tools: tools.tools.length, commands: entries.length }, null, 2))
  console.log('PASS: offline validation, reuse, initialize, 17 MCP tools, 701 commands')
  const noWindow = await client.callTool({ name: 'ui_screenshot', arguments: {} })
  assert(noWindow.isError, 'Headless screenshot must report no window, not substitute rendered output')
  await writeFile(join(scratch, 'headless-screenshot-error.json'), JSON.stringify(noWindow, null, 2))
  const { createServer } = await import('node:net')
  const reserved = createServer()
  await new Promise<void>(resolve => reserved.listen(0, '127.0.0.1', resolve))
  const noListener = `127.0.0.1:${(reserved.address() as { port: number }).port}`
  await new Promise<void>(resolve => reserved.close(() => resolve()))
  await assert.rejects(adapter.probe({ endpoint: noListener, installation, dataDir, input: {} }), /save your work before restarting it with control enabled/)
  console.log('PASS: no-window screenshot failure and missing-control remedy')
  const steps: unknown[] = []
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args })
    steps.push({ name, args, response })
    await writeFile(join(scratch, 'edit-steps.json'), JSON.stringify(steps, null, 2))
    assert(!response.isError, `${name}: ${JSON.stringify(response)}`)
    const body = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    try { return JSON.parse(body) } catch { return body }
  }
  const command = (id: string, params: Record<string, unknown> = {}) => call('command_run', { id, params })
  const image = join(scratch, 'fixture.png')
  const pixels = Buffer.alloc(320 * 180 * 3)
  for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) { const at = (y * 320 + x) * 3; pixels[at] = x % 256; pixels[at + 1] = y; pixels[at + 2] = 160 }
  await sharp(pixels, { raw: { width: 320, height: 180, channels: 3 } }).png().toFile(image)
  await command('file.newProject', { name: 'FilmCraft integration proof' })
  await command('file.newSequence', { name: 'Two-second proof', width: 320, height: 180, fps: 24, video: 1, audio: 0 })
  const imported = await call('media_import', { paths: [image] })
  console.log(`Imported: ${JSON.stringify(imported)}`)
  const item = imported.items?.[0]?.id ?? imported.items?.[0] ?? imported.imported?.[0]?.id ?? imported.imported?.[0]
  assert(item !== undefined, 'Import must identify the created project item')
  await command('timeline.place', { item, track: 'V1', seconds: 0, duration: 508032000000, video: true, audio: false })
  await command('sequence.addEdit', { seconds: 1 })
  await call('sequence_inspect', {})
  await command('file.saveAs', { path: join(scratch, 'edited.fcproj') })
  const output = join(scratch, 'edited.mp4')
  await command('file.exportMedia', { path: output, format: 'h264', width: 320, height: 180, fps: 24, audio: false, hardwareEncoding: 'off', wait: true })
  assert((await readFile(output)).byteLength > 100)
  const media = await exec('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output], { env: environment })
  const info = JSON.parse(media.stdout), video = info.streams.find((s: any) => s.codec_type === 'video')
  assert.equal(video.width, 320); assert.equal(video.height, 180); assert(Math.abs(Number(info.format.duration) - 2) < 0.15)
  const decoded = await exec('ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '2', '-f', 'framemd5', '-'], { env: environment })
  assert(decoded.stdout.split('\n').filter(line => /^0,/.test(line)).length === 2)
  await writeFile(join(scratch, 'export-inspection.json'), media.stdout)
  await writeFile(join(scratch, 'decoded-frames.txt'), decoded.stdout)
  console.log('PASS: real import, timeline placement, cut, native save and inspected two-second MP4 export')
} finally { await client.close() }
