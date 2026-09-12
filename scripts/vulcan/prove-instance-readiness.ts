import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ts from 'typescript'

const ROOT = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'instance-readiness-'))
const project = join(scratch, 'project')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_GODOT_TOOLS = '1'
process.env.MERCURY_GODOT_WORKERS = '2'
process.env.MERCURY_GODOT_LSP_PORT = '6105'
process.env.MERCURY_GODOT_DAP_PORT = '6106'
delete process.env.MERCURY_GODOT
delete process.env.MERCURY_GODOT_TOOLS_LITE

const { VULCAN_ADDON_FILES } = await import('../../src/services/vulcan/addonFiles.generated.js')
const { godotProviderInventory } = await import('../../src/services/vulcan/godotProviders.js')
const { buildGodotIdeSession, discoverGodotLaunchProfiles } = await import('../../src/services/ide/godotSession.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { resetVulcanClientForTest } = await import('../../src/services/vulcan/vulcanClient.js')
const { vulcanOp } = await import('../../src/utils/vulcan/optable.generated.js')

cpSync(join(import.meta.dir, 'fixtures/engine-service'), project, { recursive: true })
writeFileSync(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="readiness-fixture"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/mercury_vulcan/plugin.cfg")\n')
for (const file of VULCAN_ADDON_FILES) {
  const target = join(project, 'addons/mercury_vulcan', file.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, file.content)
}

const healthFile = join(ROOT, 'src/utils/healthReport.ts')
const healthSource = ts.createSourceFile(healthFile, readFileSync(healthFile, 'utf8'), ts.ScriptTarget.Latest, true)
let doctorCode = ''
function visit(node: ts.Node): void {
  if (ts.isObjectLiteralExpression(node)) {
    const id = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(healthSource) === 'id')
    if (id && ts.isPropertyAssignment(id) && ts.isStringLiteral(id.initializer) && id.initializer.text === 'vulcan') {
      const run = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(healthSource) === 'run')
      if (run && ts.isPropertyAssignment(run)) doctorCode = run.initializer.getText(healthSource)
    }
  }
  ts.forEachChild(node, visit)
}
visit(healthSource)
if (!doctorCode) throw new Error('doctor Godot row was not found')
doctorCode = doctorCode.replace(/import\((['"])(\.[^'"]+)\1\)/g, (_match, _quote, specifier) => {
  let file = resolve(dirname(healthFile), specifier)
  if (!existsSync(file)) file = file.replace(/\.js$/, '.ts')
  return `import(${JSON.stringify(pathToFileURL(file).href)})`
})
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const run = ${doctorCode}`)
const doctorRow = new Function(`${compiled}; return run`)() as () => Promise<{ status: string; evidence: string; fix?: string }>
let failures = 0
function check(label: string, value: unknown, detail: unknown = ''): void {
  if (!value) failures++
  console.log(`[${value ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

let legacyConnections = 0
const legacy = createServer(socket => { legacyConnections++; socket.end() })
await new Promise<void>(resolve => legacy.listen(0, '127.0.0.1', resolve))
const owner = makeOwnerKey({ workspace: project, sessionId: 'readiness-proof', lane: 'main' })

async function instance(role: 'agent-editor' | 'operator-editor' | 'headless-worker') {
  const id = randomBytes(16).toString('hex')
  const token = randomBytes(32).toString('hex')
  const sockets = new Set<Socket>()
  let connections = 0
  let accept = true
  const ops: string[] = []
  let identity: Record<string, unknown>
  const server = createServer(socket => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', data => {
      buffer += data.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (frame.op === 'hello') {
          if (!accept || frame.token !== token || frame.instance !== id) { socket.destroy(); return }
          socket.write(JSON.stringify({ ok: true, result: { version: 1 }, instance: identity }) + '\n')
        } else {
          ops.push(frame.op)
          const result = frame.op === 'ping' ? 'pong' : frame.op === 'scene_current' ? { edited: { path: 'res://tests/runtime_checks.tscn' } } : { fixture: true }
          socket.write(JSON.stringify({ id: frame.id, ok: true, result, instance: identity }) + '\n')
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  identity = { version: 1, id, role, port, pid: process.pid, projectRoot: project, ownerPid: process.pid }
  const dir = join(project, '.godot/mercury-vulcan', id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'token'), token, { mode: 0o600 })
  writeFileSync(join(dir, 'instance.json'), JSON.stringify(identity), { mode: 0o600 })
  return {
    id, port, ops, count: () => connections, reject: () => { accept = false },
    close: async () => {
      rmSync(dir, { recursive: true, force: true })
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
async function collect() {
  return runWithCwdOverride(project, async () => {
    const doctor = await doctorRow()
    const providers = await godotProviderInventory(project, { census: { ok: true, processes: [] } })
    const ide = await buildGodotIdeSession(owner, project)
    return { doctor, provider: providers.find(row => row.id === 'vulcan')!, ide, providers }
  })
}

try {
  const empty = await collect()
  check('a live loopback listener with no instance descriptor never makes an editor ready', empty.doctor.status !== 'ok' && empty.provider.state === 'not-answering' && empty.ide.vulcan.state === 'unreachable', empty)
  const editor = await instance('agent-editor')
  try {
    const ready = await collect()
    const expected = `project ${project} · addon installed · addon enabled · bridge up :${editor.port} · engine workers 2 (MERCURY_GODOT_WORKERS)`
    check('doctor keeps its exact row words and uses the discovered port', ready.doctor.status === 'ok' && ready.doctor.evidence === expected, ready.doctor)
    check('provider readiness names the same discovered endpoint', ready.provider.state === 'ready' && ready.provider.endpoint === `127.0.0.1:${editor.port}` && ready.provider.source === 'mercury_vulcan editor addon', ready.provider)
    check('IDE readiness keeps its exact words and uses the discovered port', ready.ide.vulcan.state === 'reachable' && ready.ide.vulcan.port === editor.port && ready.ide.vulcan.detail === `editor answering on 127.0.0.1:${editor.port}`, ready.ide.vulcan)
    check('IDE editor truth uses the same discovered client', ready.ide.editor.state === 'ok' && editor.ops.includes('editor_errors') && editor.ops.includes('scene_current') && editor.ops.includes('runtime_status'), ready.ide.editor)
    check('LSP and DAP endpoints remain separate and unchanged', ready.ide.lsp.port === 6105 && ready.ide.dap.port === 6106 && ready.providers.find(row => row.id === 'godot-lsp')?.endpoint === '127.0.0.1:6105' && ready.providers.find(row => row.id === 'godot-dap')?.endpoint === '127.0.0.1:6106')
    const profiles = await runWithCwdOverride(project, () => discoverGodotLaunchProfiles(project))
    check('current-scene discovery follows the discovered editor port too', profiles.profiles.some(row => row.kind === 'current' && row.scene === 'res://tests/runtime_checks.tscn'))
    const second = await instance('agent-editor')
    try {
      const before = editor.ops.length + second.ops.length
      const ambiguous = await collect()
      check('ambiguous agent editors are not reported ready or queried', ambiguous.doctor.status !== 'ok' && ambiguous.provider.state === 'not-answering' && ambiguous.ide.vulcan.state === 'unreachable' && editor.ops.length + second.ops.length === before)
    } finally { await second.close() }
    resetVulcanClientForTest()
    editor.reject()
    const refused = await collect()
    check('a TCP listener without a valid handshake is not ready', refused.doctor.status !== 'ok' && refused.provider.state === 'not-answering' && refused.ide.vulcan.state === 'unreachable')
  } finally { resetVulcanClientForTest(); await editor.close() }
  const operator = await instance('operator-editor')
  const worker = await instance('headless-worker')
  try {
    const operatorRows = await collect()
    const expectedOperator = `project ${project} · addon installed · addon enabled · bridge up :${operator.port} · engine workers 2 (MERCURY_GODOT_WORKERS)`
    check('a hand-started editor that answers when named reads as ready on the doctor, provider and IDE rows', operatorRows.doctor.status === 'ok' && operatorRows.doctor.evidence === expectedOperator && operatorRows.provider.state === 'ready' && operatorRows.provider.endpoint === `127.0.0.1:${operator.port}` && operatorRows.ide.vulcan.state === 'reachable' && operatorRows.ide.vulcan.port === operator.port, operatorRows.doctor)
    check('the operator editor is reported through read-only calls and never operated on; a runtime worker is never a readiness target', operator.ops.length > 0 && operator.ops.every(op => op === 'ping' || vulcanOp(op)?.cls === 'read') && worker.count() === 0, operator.ops)
    const agent = await instance('agent-editor')
    try {
      const before = operator.ops.length + agent.ops.length
      const ambiguous = await collect()
      check('an operator editor beside an agent editor is ambiguous: not ready, both named, neither queried', ambiguous.doctor.status !== 'ok' && ambiguous.provider.state === 'not-answering' && ambiguous.ide.vulcan.state === 'unreachable' && ambiguous.doctor.evidence.includes(operator.id) && ambiguous.doctor.evidence.includes(agent.id) && !/unbridged/.test(ambiguous.doctor.evidence) && operator.ops.length + agent.ops.length === before, ambiguous.doctor)
    } finally { await agent.close() }
    resetVulcanClientForTest()
  } finally { resetVulcanClientForTest(); await operator.close(); await worker.close() }
  check('the undiscovered listener was never contacted', legacyConnections === 0, legacyConnections)
} finally {
  resetVulcanClientForTest()
  await new Promise<void>(resolve => legacy.close(() => resolve()))
}
console.log(`instance readiness proof: ${failures} failures; scratch ${scratch}`)
process.exitCode = failures > 0 ? 1 : 0
