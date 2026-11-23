import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

const { VULCAN_ADDON_FILES } = await import('../../src/integrations/vulcan/addonFiles.generated.js')
const { godotProviderInventory } = await import('./godotProviders.js')
const { buildGodotIdeSession, discoverGodotLaunchProfiles } = await import('../../src/integrations/ide/godotSession.js')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.js')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')
const { resetVulcanClientForTest } = await import('../../src/integrations/vulcan/vulcanClient.js')
const { vulcanOp } = await import('../../src/integrations/vulcan-optable/optable.generated.js')

cpSync(join(import.meta.dir, 'fixtures/engine-service'), project, { recursive: true })
writeFileSync(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="readiness-fixture"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/mercury_vulcan/plugin.cfg")\n')
for (const file of VULCAN_ADDON_FILES) {
  const target = join(project, 'addons/mercury_vulcan', file.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, file.content)
}

const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
const vulcanSpec = runtimeChecks().find(row => row.id === 'vulcan')
if (!vulcanSpec) throw new Error('health Godot row was not found')
const healthRow = vulcanSpec.run as () => Promise<{ status: string; evidence: string; fix?: string }>
let failures = 0
function check(label: string, value: unknown, detail: unknown = '', hint = ''): void {
  if (!value) failures++
  const shown = detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''
  const failHint = !value && hint ? hint : ''
  const joined = shown && failHint ? `${shown} — ${failHint}` : shown || failHint
  console.log(`[${value ? 'PASS' : 'FAIL'}] ${label}${joined ? ` — ${joined}` : ''}`)
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
    const health = await healthRow()
    const providers = await godotProviderInventory(project, { census: { ok: true, processes: [] } })
    const ide = await buildGodotIdeSession(owner, project)
    return { health, provider: providers.find(row => row.id === 'vulcan')!, ide, providers }
  })
}

try {
  const empty = await collect()
  check('a live loopback listener with no instance descriptor never makes an editor ready', empty.health.status !== 'ok' && empty.provider.state === 'not-answering' && empty.ide.vulcan.state === 'unreachable', empty, 'readiness must come only from a live instance descriptor under .godot/mercury-vulcan; see scanVulcanInstances in src/integrations/vulcan/instances.ts, vulcanCheck in src/platform/health/sections/runtime/services.ts and buildGodotIdeSession in src/integrations/ide/godotSession.ts')
  const editor = await instance('agent-editor')
  try {
    const ready = await collect()
    const expected = `project ${project} · addon installed · addon enabled · bridge up :${editor.port} · engine workers 2 (MERCURY_GODOT_WORKERS)`
    check('health keeps its exact row words and uses the discovered port', ready.health.status === 'ok' && ready.health.evidence === expected, ready.health, 'vulcanCheck in src/platform/health/sections/runtime/services.ts must report ok with the evidence words above and the port from the discovered instance')
    check('provider readiness names the same discovered endpoint', ready.provider.state === 'ready' && ready.provider.endpoint === `127.0.0.1:${editor.port}` && ready.provider.source === 'mercury_vulcan editor addon', ready.provider, 'the vulcan row of godotProviderInventory in scripts/vulcan/godotProviders.ts must report ready with the discovered endpoint')
    check('IDE readiness keeps its exact words and uses the discovered port', ready.ide.vulcan.state === 'reachable' && ready.ide.vulcan.port === editor.port && ready.ide.vulcan.detail === `editor answering on 127.0.0.1:${editor.port}`, ready.ide.vulcan, 'buildGodotIdeSession in src/integrations/ide/godotSession.ts must report the vulcan row reachable on the discovered port with these exact words')
    check('IDE editor truth uses the same discovered client', ready.ide.editor.state === 'ok' && editor.ops.includes('editor_errors') && editor.ops.includes('scene_current') && editor.ops.includes('runtime_status'), ready.ide.editor, 'buildGodotIdeSession in src/integrations/ide/godotSession.ts must query the editor through the discovered instance client (editor_errors, scene_current, runtime_status)')
    check('LSP and DAP endpoints remain separate and unchanged', ready.ide.lsp.port === 6105 && ready.ide.dap.port === 6106 && ready.providers.find(row => row.id === 'godot-lsp')?.endpoint === '127.0.0.1:6105' && ready.providers.find(row => row.id === 'godot-dap')?.endpoint === '127.0.0.1:6106', '', 'the LSP and DAP ports come from MERCURY_GODOT_LSP_PORT and MERCURY_GODOT_DAP_PORT; buildGodotIdeSession in src/integrations/ide/godotSession.ts and godotProviderInventory in scripts/vulcan/godotProviders.ts must keep them apart from the vulcan port')
    const profiles = await runWithCwdOverride(project, () => discoverGodotLaunchProfiles(project))
    check('current-scene discovery follows the discovered editor port too', profiles.profiles.some(row => row.kind === 'current' && row.scene === 'res://tests/runtime_checks.tscn'), '', 'discoverGodotLaunchProfiles in src/integrations/ide/godotSession.ts must read the current scene through the discovered editor port')
    const second = await instance('agent-editor')
    try {
      const before = editor.ops.length + second.ops.length
      const ambiguous = await collect()
      check('ambiguous agent editors are not reported ready or queried', ambiguous.health.status !== 'ok' && ambiguous.provider.state === 'not-answering' && ambiguous.ide.vulcan.state === 'unreachable' && editor.ops.length + second.ops.length === before, '', 'with two agent-editor instances selectVulcanInstance in src/integrations/vulcan/instances.ts returns INSTANCE_AMBIGUOUS; health, provider and IDE rows must report not ready and send no op to either editor')
    } finally { await second.close() }
    resetVulcanClientForTest()
    editor.reject()
    const refused = await collect()
    check('a TCP listener without a valid handshake is not ready', refused.health.status !== 'ok' && refused.provider.state === 'not-answering' && refused.ide.vulcan.state === 'unreachable', '', 'an instance whose hello handshake is refused must not count as ready; see the vulcan client in src/integrations/vulcan/vulcanClient.ts and vulcanCheck in src/platform/health/sections/runtime/services.ts')
  } finally { resetVulcanClientForTest(); await editor.close() }
  const operator = await instance('operator-editor')
  const worker = await instance('headless-worker')
  try {
    const operatorRows = await collect()
    const expectedOperator = `project ${project} · addon installed · addon enabled · bridge up :${operator.port} · engine workers 2 (MERCURY_GODOT_WORKERS)`
    check('a hand-started editor that answers when named reads as ready on /health, provider and IDE rows', operatorRows.health.status === 'ok' && operatorRows.health.evidence === expectedOperator && operatorRows.provider.state === 'ready' && operatorRows.provider.endpoint === `127.0.0.1:${operator.port}` && operatorRows.ide.vulcan.state === 'reachable' && operatorRows.ide.vulcan.port === operator.port, operatorRows.health, 'an operator-editor instance that answers must read as ready in vulcanCheck (src/platform/health/sections/runtime/services.ts), the provider row and buildGodotIdeSession (src/integrations/ide/godotSession.ts)')
    check('the operator editor is reported through read-only calls and never operated on; a runtime worker is never a readiness target', operator.ops.length > 0 && operator.ops.every(op => op === 'ping' || vulcanOp(op)?.cls === 'read') && worker.count() === 0, operator.ops, 'the readiness probes must send only ping and read-class ops (vulcanOp in src/integrations/vulcan-optable/optable.generated.js) to the operator editor and never connect to a headless-worker')
    const agent = await instance('agent-editor')
    try {
      const before = operator.ops.length + agent.ops.length
      const ambiguous = await collect()
      check('an operator editor beside an agent editor is ambiguous: not ready, both named, neither queried', ambiguous.health.status !== 'ok' && ambiguous.provider.state === 'not-answering' && ambiguous.ide.vulcan.state === 'unreachable' && ambiguous.health.evidence.includes(operator.id) && ambiguous.health.evidence.includes(agent.id) && !/unbridged/.test(ambiguous.health.evidence) && operator.ops.length + agent.ops.length === before, ambiguous.health, 'with an operator editor and an agent editor, selection in src/integrations/vulcan/instances.ts and vulcanCheck in src/platform/health/sections/runtime/services.ts must report ambiguous: not ready, both ids named, no op sent')
    } finally { await agent.close() }
    resetVulcanClientForTest()
  } finally { resetVulcanClientForTest(); await operator.close(); await worker.close() }
  check('the undiscovered listener was never contacted', legacyConnections === 0, legacyConnections, 'readiness must not connect to a listener that has no instance descriptor; find the code that dials the legacy port in src/integrations/vulcan/vulcanClient.ts or src/integrations/lsp/godotLane.ts')
} finally {
  resetVulcanClientForTest()
  await new Promise<void>(resolve => legacy.close(() => resolve()))
}
console.log(`instance readiness proof: ${failures} failures; scratch ${scratch}`)
process.exitCode = failures > 0 ? 1 : 0
