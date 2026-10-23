#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const scratch = option('--scratch')
assert(scratch && isAbsolute(scratch), 'Pass --scratch <isolated absolute proof folder>')
assert(process.argv.some(v => ['--install', '--check', '--headless', '--gui'].includes(v)), 'Choose --install, --check, --headless or --gui')
const dirs = { data: join(scratch, 'data'), home: join(scratch, 'home'), config: join(scratch, 'config'), tmp: join(scratch, 'tmp'), read: join(scratch, 'project'), output: join(scratch, 'outputs'), evidence: join(scratch, 'evidence') }
for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true, mode: 0o700 })
const delivered = join(scratch, 'extension')
cpSync(join(root, 'src/extensions/bundled/photocraft'), delivered, { recursive: true })
cpSync(option('--shared-dir') ?? join(root, 'src/extensions/bundled/shared'), join(delivered, 'shared'), { recursive: true })
const { adapter, tokenPath, readPrivateToken, inspectControl } = await import(pathToFileURL(join(delivered, 'server/install.mjs')).href)
const { installPinned, checkInstall, planInstall } = await import(pathToFileURL(join(delivered, 'shared/install.mjs')).href)
const { controlSession } = await import(pathToFileURL(join(delivered, 'shared/control.mjs')).href)
const env = { ...process.env, HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_STATE_HOME: dirs.config, APPDATA: dirs.config, LOCALAPPDATA: dirs.config, PHOTOCRAFT_CONFIG_DIR: dirs.config, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, MERCURY_CONFIG_DIR: join(scratch, 'mercury-config'), MERCURY_EXTENSION_DATA: dirs.data }
const report: any = { platform: `${process.platform}-${process.arch}`, checks: [], frames: [] }
function passed(name: string, value?: unknown) { report.checks.push({ name, ...(value === undefined ? {} : { value }) }); console.log(`PASS ${name}${value === undefined ? '' : `: ${JSON.stringify(value)}`}`) }
function command(binary: string, args: string[], required = true) {
  const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 30000 })
  const observed = { code: result.status, stdout: result.stdout?.trim(), stderr: result.stderr?.trim(), error: result.error?.message }
  report.checks.push({ name: `${binary} ${args.join(' ')}`, ...observed })
  if (required) assert.equal(result.status, 0, JSON.stringify(observed))
  return observed
}
class MCP {
  child: ReturnType<typeof spawn>
  next = 0
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  transcript: any[] = []
  stderr = ''
  label: string
  constructor(label: string, binary = process.env.MERCURY_NODE ?? 'node', args = [join(delivered, 'server/bridge.mjs')]) {
    this.label = label
    this.child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stderr!.on('data', b => { this.stderr += b })
    createInterface({ input: this.child.stdout! }).on('line', line => {
      const reply = JSON.parse(line); this.transcript.push(reply)
      const pending = this.pending.get(reply.id)
      if (pending && !reply.method) { this.pending.delete(reply.id); clearTimeout(pending.timer); pending.resolve(reply) }
    })
    this.child.on('error', error => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }; this.pending.clear() })
    this.child.on('exit', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited: ${this.stderr}`)) }; this.pending.clear() })
  }
  request(method: string, params: unknown = {}) {
    return new Promise<any>((resolve, reject) => { const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`No reply from ${method}; inspect before retrying`)) }, 80000); this.pending.set(id, { resolve, reject, timer }); this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  }
  async initialize() {
    const response = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mercury-photocraft-live-proof', version: '1' } })
    assert(response.result, JSON.stringify(response))
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return response.result
  }
  async call(name: string, args: unknown = {}) {
    const response = await this.request('tools/call', { name, arguments: args })
    assert(!response.error && !response.result?.isError, JSON.stringify(response))
    return response.result
  }
  async json(name: string, args: unknown = {}) { return JSON.parse((await this.call(name, args)).content.find((x: any) => x.type === 'text').text) }
  async refused(name: string, args: unknown, pattern: RegExp) {
    const response = await this.request('tools/call', { name, arguments: args })
    assert(response.error || response.result?.isError, JSON.stringify(response)); assert.match(JSON.stringify(response), pattern)
    return response
  }
  async close() {
    this.child.stdin!.end()
    await new Promise<void>(resolve => { if (this.child.exitCode !== null) return resolve(); const timer = setTimeout(() => { this.child.kill(); resolve() }, 3000); this.child.once('exit', () => { clearTimeout(timer); resolve() }) })
    for (const p of this.pending.values()) clearTimeout(p.timer)
    writeFileSync(join(dirs.evidence, `${this.label}.json`), JSON.stringify(this.transcript, null, 2))
    writeFileSync(join(dirs.evidence, `${this.label}.stderr`), this.stderr)
  }
}

let installation: any
try {
  if (process.argv.includes('--install')) {
    const initial = await checkInstall(adapter, { dataDir: dirs.data }); assert.equal(initial.state, 'absent', 'Clean-cache proof requires a new --scratch folder')
    let asks = 0
    installation = await installPinned(adapter, { dataDir: dirs.data, authorize: async (plan: any) => { asks++; writeFileSync(join(dirs.evidence, 'install-plan.json'), JSON.stringify(plan, null, 2)); return true } })
    assert.equal(asks, 1); assert.equal(installation.reused, false)
    passed('real clean-cache installation', installation.manifest.archives)
    const reused = await installPinned(adapter, { dataDir: dirs.data, authorize: () => { throw new Error('Reused installation asked again') } }); assert(reused.reused)
    passed('same-version offline reuse')
  }
  const checked = await checkInstall(adapter, { dataDir: dirs.data }); assert.equal(checked.state, 'installed', JSON.stringify(checked)); installation = checked.installation
  passed('offline archive identity, licences and tree digest', { fileCount: installation.manifest.fileCount, treeDigest: installation.manifest.treeDigest })
  const cliVersion = command(installation.cli, ['--version']), guiVersion = command(installation.gui, ['--version'])
  assert.match(cliVersion.stdout!, /photocraft-cli 0\.14\.0/); assert.match(guiVersion.stdout!, /photocraft 0\.14\.0/i)
  if (process.platform === 'darwin') {
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', installation.cli])
    const app = installation.gui.slice(0, installation.gui.indexOf('.app/') + 4)
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    command('/usr/sbin/spctl', ['--assess', '--type', 'execute', app], false)
  } else if (process.platform === 'win32') {
    const escaped = installation.gui.replaceAll("'", "''")
    command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-AuthenticodeSignature -LiteralPath '${escaped}' | Select-Object Status,StatusMessage | ConvertTo-Json -Compress`])
  }
  const input = Buffer.alloc(8 * 6 * 4)
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) input.set([x * 30, y * 40, 90, 255], (y * 8 + x) * 4)
  await sharp(input, { raw: { width: 8, height: 6, channels: 4 } }).png().toFile(join(dirs.read, 'fixture.png'))

  async function discover(mcp: MCP, mode: string) {
    const listed = await mcp.request('tools/list')
    const names = listed.result.tools.map((t: any) => t.name)
    assert.equal(names.length, 28); assert(names.includes('ui_screenshot')); assert(names.includes('doc_export_layers'))
    const commands = await mcp.json('command_list'); assert(Array.isArray(commands)); assert(commands.length >= 935)
    assert(commands.some((c: any) => c.id === 'image.crop' && c.params.includes('width')))
    const resources = await mcp.request('resources/list'); assert(resources.result.resources.some((r: any) => r.uri === 'photocraft://document'))
    passed(`${mode} full upstream MCP discovery`, { upstreamTools: names.length - 3, bootstrapTools: 3, commands: commands.length })
  }
  if (process.argv.includes('--headless')) {
    let edits = 0, connections = 0, disconnect = true
    const standIn = createServer(socket => {
      connections++
      createInterface({ input: socket }).on('line', line => {
        const request = JSON.parse(line)
        if (request.method === 'auth') socket.write(JSON.stringify({ id: request.id, ok: true, result: null }) + '\n')
        else { edits++; if (disconnect) socket.destroy() }
      })
    })
    await new Promise<void>(resolve => standIn.listen(0, '127.0.0.1', resolve))
    const fakeEndpoint = `127.0.0.1:${(standIn.address() as { port: number }).port}`
    const dummyFile = join(dirs.tmp, 'transport-test.token'); writeFileSync(dummyFile, 'b'.repeat(64), { mode: 0o600 })
    try {
      await assert.rejects(adapter.probe({ endpoint: fakeEndpoint, dataDir: dirs.data, installation }), /different executable|not the verified installation/)
      assert.equal(connections, 0); passed('wrong control process rejected before credentials or app protocol are sent')
      await assert.rejects(adapter.launch({ endpoint: fakeEndpoint, dataDir: join(dirs.data, 'collision'), installation, input: { readRoot: dirs.read, writeRoot: dirs.output } }), /port is already in use/)
      passed('occupied port refused before launching a GUI')
      const transport = new MCP('disconnect', installation.cli, ['mcp', '--bridge', fakeEndpoint, '--control-token-file', dummyFile])
      try {
        await transport.initialize()
        await transport.refused('command_run', { id: 'image.crop', params: { x: 0, y: 0, width: 1, height: 1 } }, /operation may have completed; inspect state before retrying/)
        assert.equal(edits, 1); passed('released CLI reports unknown outcome after disconnect and never replays the edit')
      } finally { await transport.close() }
      disconnect = false; edits = 0
      const timed = new MCP('timeout', installation.cli, ['mcp', '--bridge', fakeEndpoint, '--control-token-file', dummyFile])
      try {
        await timed.initialize()
        await timed.refused('command_run', { id: 'image.crop', params: { x: 0, y: 0, width: 1, height: 1 } }, /timed out.*operation may have completed; inspect state before retrying/)
        assert.equal(edits, 1); passed('released CLI timeout preserves unknown outcome and does not retry the edit')
      } finally { await timed.close() }
    } finally { standIn.close() }
    const mcp = new MCP('headless')
    try {
      await mcp.initialize(); await mcp.call('craft_connect', { mode: 'headless', readRoot: dirs.read, writeRoot: dirs.output })
      await discover(mcp, 'headless')
      await mcp.json('doc_open', { path: 'fixture.png' })
      await mcp.json('command_run', { id: 'image.crop', params: { x: 2, y: 1, width: 4, height: 3 } })
      await mcp.json('doc_save', { path: 'headless-crop.png' })
      const { data, info } = await sharp(join(dirs.output, 'headless-crop.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 4); assert.equal(info.height, 3)
      for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 4; c++) assert.equal(data[(y * 4 + x) * 4 + c], input[((y + 1) * 8 + x + 2) * 4 + c])
      passed('headless crop PNG independently decoded; every RGBA byte matched')
      await mcp.json('command_run', { id: 'layer.new.layer', params: { name: 'Proof layer' } }); await mcp.json('doc_save', { path: 'headless-layered.psd' })
      const infoPSD = JSON.parse(command(installation.cli, ['info', join(dirs.output, 'headless-layered.psd'), '--compact']).stdout!)
      assert.equal(infoPSD.layers.length, 2); assert.equal(infoPSD.width, 4); assert.equal(infoPSD.height, 3)
      passed('saved PSD reopened with two layers')
      await mcp.refused('doc_open', { path: '../outputs/headless-crop.png' }, /outside|traversal|escape|parent|root|relative/i)
      await mcp.refused('doc_save', { path: '../escape.png' }, /outside|traversal|escape|parent|root|relative/i)
      await mcp.refused('command_run', { id: 'file.saveAs', params: { path: join(scratch, 'escape.png') } }, /ambient|scoped|disabled/i)
      await mcp.refused('doc_save', { path: 'missing/export.png' }, /directory|No such file|not found|system cannot/i)
      await mcp.refused('ui_screenshot', {}, /bridge|desktop|headless/i)
      await mcp.json('doc_open', { path: 'fixture.png' }); await mcp.json('command_run', { id: 'layer.smartObjects.convertToSmartObject', params: {} })
      await mcp.json('command_run', { id: 'filter.distort.displace', params: { horizontal: 0, vertical: 0, mapDocument: 0 } })
      const before = await mcp.json('doc_inspect')
      await mcp.refused('command_run', { id: 'layer.smartFilter.setParams', params: { index: 0, params: { mapPath: join(scratch, 'outside.png') } } }, /ambient|scoped|disabled/i)
      assert.deepEqual(await mcp.json('doc_inspect'), before)
      passed('root escapes, ambient save, failed export, absent GUI and merged Smart Filter paths refused')
    } finally { await mcp.close() }
  }
  if (process.argv.includes('--gui')) {
    const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = (portServer.address() as { port: number }).port; await new Promise<void>(resolve => portServer.close(() => resolve()))
    const endpoint = process.argv.includes('--attach') ? JSON.parse(readFileSync(join(dirs.data, 'photocraft-instance.json'), 'utf8')).endpoint : `127.0.0.1:${port}`
    const mcp = new MCP('gui-launch')
    let guiPid = 0, success = false
    try {
      await mcp.initialize(); await mcp.call('craft_connect', { mode: process.argv.includes('--attach') ? 'attach' : 'launch', endpoint, readRoot: dirs.read, writeRoot: dirs.output })
      guiPid = JSON.parse(readFileSync(join(dirs.data, 'photocraft-instance.json'), 'utf8')).pid
      await assert.rejects(adapter.launch({ installation, endpoint, dataDir: dirs.data, input: { readRoot: dirs.read, writeRoot: dirs.output } }), /already running/)
      process.kill(guiPid, 0); passed('duplicate GUI launch refused without stopping the existing process')
      await discover(mcp, 'attached GUI')
      await mcp.json('doc_open', { path: 'fixture.png' }); await mcp.call('ui_set', { fields: { zoom: 64 } })
      async function screenshot(name: string) { const shot = await mcp.call('ui_screenshot'); const image = shot.content.find((x: any) => x.type === 'image'); assert(image && image.mimeType === 'image/png'); const path = join(dirs.evidence, name); writeFileSync(path, Buffer.from(image.data, 'base64')); assert((await sharp(path).metadata()).width! > 100); report.frames.push(path); return path }
      await screenshot('gui-before.png')
      const before = await mcp.json('command_run', { id: 'document.pixel', params: { x: 0, y: 0 } })
      await mcp.call('ui_menu_invoke', { id: 'image.imageRotation.flipCanvasHorizontal' })
      const after = await mcp.json('command_run', { id: 'document.pixel', params: { x: 0, y: 0 } }); assert.notDeepEqual(after, before)
      passed('GUI menu edit visible through MCP pixel read', { before, after })
      await screenshot('gui-after-menu.png')
      await mcp.json('command_run', { id: 'image.crop', params: { x: 2, y: 1, width: 4, height: 3 } })
      await mcp.json('doc_save', { path: 'gui-crop.png' }); await mcp.call('ui_set', { fields: { zoom: 64 } })
      const { data, info } = await sharp(join(dirs.output, 'gui-crop.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 4); assert.equal(info.height, 3)
      for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 4; c++) assert.equal(data[(y * 4 + x) * 4 + c], input[((y + 1) * 8 + 7 - (x + 2)) * 4 + c])
      await screenshot('gui-after-mcp.png')
      await mcp.refused('doc_open', { path: '../outputs/gui-crop.png' }, /outside|traversal|escape|parent|root|relative/i)
      await mcp.refused('doc_save', { path: '../escape.png' }, /outside|traversal|escape|parent|root|relative/i)
      passed('MCP crop visible in the same GUI; exported PNG pixels independently matched')
      const wrongFile = join(dirs.data, 'photocraft-control', 'wrong.token'); writeFileSync(wrongFile, '0'.repeat(64), { mode: 0o600 })
      await assert.rejects(inspectControl({ endpoint, tokenFile: wrongFile }), /authentication failed/)
      passed('running desktop refuses wrong token')
      await mcp.close(); process.kill(guiPid, 0)
      const second = new MCP('gui-reattach')
      try {
        await second.initialize(); await second.call('craft_connect', { mode: 'attach', endpoint, tokenFile: tokenPath(dirs.data), readRoot: dirs.read, writeRoot: dirs.output })
        const document = await second.json('doc_inspect'); assert.equal(document.width, 4); assert.equal(document.height, 3)
        passed('reattached to existing process and same document without launching', { pid: guiPid, width: document.width, height: document.height })
      } finally { await second.close() }
      process.kill(guiPid, 0); passed('closing both MCP sessions leaves the GUI running'); success = true
    } finally {
      await mcp.close()
      if (success && guiPid) {
        const control = controlSession(endpoint)
        try { await control.request('auth', { token: readPrivateToken(tokenPath(dirs.data)) }); await control.request('app.quit') } finally { control.close() }
        const deadline = Date.now() + 10000
        let exited = false
        while (Date.now() < deadline) {
          try { process.kill(guiPid, 0) } catch { exited = true; break }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        assert(exited, 'The proof GUI did not finish quitting')
      } else if (guiPid) console.error(`PhotoCraft proof window left open for inspection (process ${guiPid}).`)
    }
    if (success) {
      const ordinaryEnv = { ...env, PHOTOCRAFT_CONFIG_DIR: join(dirs.config, 'ordinary') }
      for (const key of ['PHOTOCRAFT_CONTROL_TOKEN', 'PHOTOCRAFT_CONTROL_TOKEN_FILE', 'PHOTOCRAFT_CONTROL_PORT']) delete (ordinaryEnv as Record<string, unknown>)[key]
      const ordinary = spawn(installation.gui, [join(dirs.read, 'fixture.png')], { env: ordinaryEnv, stdio: 'ignore' })
      try {
        await new Promise<void>((resolve, reject) => { ordinary.once('spawn', resolve); ordinary.once('error', reject) })
        await assert.rejects(adapter.launch({ installation, endpoint, dataDir: join(dirs.data, 'other-instance'), input: { readRoot: dirs.read, writeRoot: dirs.output } }), /already running.*Save your work/s)
        process.kill(ordinary.pid!, 0); passed('ordinary window without control is preserved and gives a save-and-restart remedy')
      } finally {
        ordinary.kill()
        await new Promise<void>(resolve => { if (ordinary.exitCode !== null) return resolve(); const timer = setTimeout(resolve, 3000); ordinary.once('exit', () => { clearTimeout(timer); resolve() }) })
      }
    }
  }
  const final = await checkInstall(adapter, { dataDir: dirs.data }); assert.equal(final.state, 'installed', JSON.stringify(final))
  passed('post-run offline validation')
  report.success = true
} finally {
  const phase = ['install', 'check', 'headless', 'gui'].filter(name => process.argv.includes(`--${name}`)).join('-')
  writeFileSync(join(dirs.evidence, `report-${phase}.json`), JSON.stringify(report, null, 2))
  writeFileSync(join(dirs.evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Evidence: ${dirs.evidence}`)
}
