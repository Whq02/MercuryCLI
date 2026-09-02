#!/usr/bin/env bun
// ============================================================================
//  scripts/lsp/prove-godot-lane.ts
//  PROOF: the Godot/GDScript IDE-hands lane (`mercury-godot` +
//  the `godot` DAP adapter, MERCURY_GODOT opt-in) — the registry evidence
//  artifact for the flag row.
//
//   §1  opt-in polarity: unset ⇒ NOTHING (no LSP source, no DAP adapter —
//       byte-identical); =1 arms both surfaces.
//   §2  project detection: nearest project.godot root from a nested cwd;
//       no project ⇒ honest absence.
//   §3  ports: defaults 6005/6006, env overrides, invalid values fall back.
//   §4  LSP config shape: bridge respawn command, .gd → gdscript claim,
//       workspaceFolder = project root; a proof context WITHOUT the entry
//       override refuses the respawn honestly (the argv[1] guard).
//   §5  LIVE bridge: framed JSON-RPC initialize round-trips through the REAL
//       tcp bridge to a fake TCP LSP server; peer close exits 0; an
//       unreachable port exits 2 with the lane's teaching hint; non-loopback
//       targets refuse.
//   §6  DAP adapter: resolves only when armed; launch args speak the editor
//       contract {project, scene, playArgs} (debug_adapter_parser.cpp).
//   §7  registry honesty: flag rows + generated doc.
//
//  Run:  ~/.bun/bin/bun run scripts/lsp/prove-godot-lane.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' mercury-godot lane (MERCURY_GODOT) — proof')
console.log('============================================================')

const repo = path.resolve(import.meta.dir, '../..')
const bridgeEntry = path.join(repo, 'src/services/tcpBridge/entry.ts')

const {
  mercuryGodotEnabled,
  godotLspPort,
  godotDapPort,
  findGodotProjectRoot,
  builtinGodotServer,
  probeGodotLane,
  MERCURY_GODOT_SERVER_NAME,
  GODOT_DAP_ADAPTER_KEY,
} = await import('../../src/services/lsp/godotLane.js')
const { getMercuryLspServerSources } = await import(
  '../../src/services/lsp/builtinServers.js'
)
const { resolveAdapter, knownAdapterKeys } = await import(
  '../../src/services/dap/dapClient.js'
)
const { parseBridgeTarget, isLoopbackHost } = await import(
  '../../src/services/tcpBridge/entry.js'
)
// getCwd() reads the bootstrap cwd state, NOT live process.cwd() — proofs
// steer it through the production async-local override seam.
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'godot-lane-'))
const proj = path.join(scratch, 'game')
mkdirSync(path.join(proj, 'scripts'), { recursive: true })
writeFileSync(path.join(proj, 'project.godot'), '[application]\n')

const savedEnv = { ...process.env }
const savedCwd = process.cwd()
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  process.chdir(savedCwd)
}

section('§1 · opt-in polarity (default OFF, byte-identical)')
{
  restore()
  delete process.env.MERCURY_GODOT
  check('unset: gate OFF', !mercuryGodotEnabled())
  check(
    'unset: no mercury-godot source even inside a Godot project',
    runWithCwdOverride(
      proj,
      () => !(MERCURY_GODOT_SERVER_NAME in getMercuryLspServerSources().builtin),
    ),
  )
  check(
    'unset: no godot DAP adapter',
    resolveAdapter(GODOT_DAP_ADAPTER_KEY) === null &&
      !knownAdapterKeys().includes(GODOT_DAP_ADAPTER_KEY),
  )
  process.env.MERCURY_GODOT = '1'
  check('=1: gate ON (live re-read)', mercuryGodotEnabled())
}

section('§2 · project detection')
{
  restore()
  process.env.MERCURY_GODOT = '1'
  check(
    'nearest project.godot root found from a nested dir',
    findGodotProjectRoot(path.join(proj, 'scripts')) === proj,
  )
  check(
    'no project.godot ⇒ undefined',
    findGodotProjectRoot(scratch) === undefined,
  )
  const probe = runWithCwdOverride(scratch, () => probeGodotLane())
  check(
    'probe without a project: enabled but honest reason',
    probe.enabled && !probe.projectRoot && (probe.reason ?? '').includes('project.godot'),
  )
}

section('§3 · ports')
{
  restore()
  delete process.env.MERCURY_GODOT_LSP_PORT
  delete process.env.MERCURY_GODOT_DAP_PORT
  check('default ports 6005/6006', godotLspPort() === 6005 && godotDapPort() === 6006)
  process.env.MERCURY_GODOT_LSP_PORT = '7777'
  process.env.MERCURY_GODOT_DAP_PORT = '7778'
  check('env overrides honored', godotLspPort() === 7777 && godotDapPort() === 7778)
  process.env.MERCURY_GODOT_LSP_PORT = 'abc'
  process.env.MERCURY_GODOT_DAP_PORT = '99999'
  check('invalid values fall back to defaults', godotLspPort() === 6005 && godotDapPort() === 6006)
}

section('§4 · LSP config shape')
{
  restore()
  process.env.MERCURY_GODOT = '1'
  const inProject = <T,>(fn: () => T): T =>
    runWithCwdOverride(path.join(proj, 'scripts'), fn)

  delete process.env.MERCURY_TCP_BRIDGE_ENTRY
  check(
    'proof context without entry override: respawn refused ⇒ no config (argv[1] guard)',
    inProject(() => Object.keys(builtinGodotServer()).length === 0),
  )

  process.env.MERCURY_TCP_BRIDGE_ENTRY = bridgeEntry
  process.env.MERCURY_GODOT_LSP_PORT = '7005'
  const config = inProject(() => builtinGodotServer())[MERCURY_GODOT_SERVER_NAME]
  check('config present with entry override', config !== undefined)
  if (config) {
    check('command is the node/bun runtime', config.command === process.execPath)
    const args = config.args ?? []
    check(
      'args: direct entry + loopback target on the configured port',
      args[0] === bridgeEntry && args[1] === '127.0.0.1:7005',
    )
    check('args carry the teaching --hint', args.includes('--hint'))
    check('.gd claims gdscript', config.extensionToLanguage['.gd'] === 'gdscript')
    check('workspaceFolder is the project root', config.workspaceFolder === proj)
    check('source stamped mercury-builtin', config.source === 'mercury-builtin')
  }
  delete process.env.MERCURY_GODOT_LSP_PORT
}

section('§5 · LIVE bridge (fake TCP LSP server)')
await (async () => {
  restore()
  // Fake server: one connection, answer initialize, then close on request.
  let sockets: net.Socket[] = []
  const server = net.createServer(socket => {
    sockets.push(socket)
    let buf = Buffer.alloc(0)
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      const headerEnd = buf.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString())
      if (!m) return
      const len = Number(m[1])
      const start = headerEnd + 4
      if (buf.length < start + len) return
      const body = JSON.parse(buf.subarray(start, start + len).toString()) as {
        id?: number
        method?: string
      }
      buf = buf.subarray(start + len)
      if (body.method === 'initialize') {
        const resp = JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { capabilities: {}, serverInfo: { name: 'fake-godot-ls' } },
        })
        socket.write(`Content-Length: ${Buffer.byteLength(resp)}\r\n\r\n${resp}`)
      }
    })
  })
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as net.AddressInfo).port

  // Round-trip through the REAL bridge.
  const child = spawn(process.execPath, [bridgeEntry, `127.0.0.1:${port}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const req = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} })
  child.stdin.write(`Content-Length: ${Buffer.byteLength(req)}\r\n\r\n${req}`)
  const response = await new Promise<string>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`no response; got: ${out}`)), 8000)
    child.stdout.on('data', d => {
      out += String(d)
      if (out.includes('fake-godot-ls')) {
        clearTimeout(timer)
        resolve(out)
      }
    })
  }).catch(e => String(e))
  check(
    'initialize round-trips through the bridge',
    response.includes('"id":7') && response.includes('fake-godot-ls'),
    response.slice(0, 120),
  )
  // Server-side close ⇒ bridge exits 0.
  for (const s of sockets) s.end()
  const exitCode = await new Promise<number | null>(res => {
    const t = setTimeout(() => res(-1), 5000)
    child.on('exit', code => {
      clearTimeout(t)
      res(code)
    })
  })
  check('peer close ⇒ bridge exits 0', exitCode === 0, `exit=${exitCode}`)
  await new Promise<void>(res => server.close(() => res()))

  // Unreachable port ⇒ exit 2 with the hint.
  const dead = spawn(process.execPath, [bridgeEntry, '127.0.0.1:1', '--hint', 'OPEN-THE-EDITOR'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let deadErr = ''
  dead.stderr.on('data', d => (deadErr += String(d)))
  const deadExit = await new Promise<number | null>(res => {
    const t = setTimeout(() => res(-1), 15000)
    dead.on('exit', code => {
      clearTimeout(t)
      res(code)
    })
  })
  check('unreachable port ⇒ exit 2', deadExit === 2, `exit=${deadExit}`)
  check(
    'failure stderr carries cannot-reach + the lane hint',
    deadErr.includes('cannot reach') && deadErr.includes('OPEN-THE-EDITOR'),
    deadErr.slice(0, 140),
  )

  // Loopback guard (pure).
  check('non-loopback target refused', 'error' in parseBridgeTarget('10.0.0.5:6005'))
  check('loopback hosts accepted', isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && isLoopbackHost('::1'))
  check('malformed target refused', 'error' in parseBridgeTarget('nonsense'))
  check('port bounds enforced', 'error' in parseBridgeTarget('127.0.0.1:70000'))
})()

section('§6 · DAP adapter (editor launch contract)')
{
  restore()
  process.env.MERCURY_GODOT = '1'
  process.env.MERCURY_TCP_BRIDGE_ENTRY = bridgeEntry
  process.env.MERCURY_GODOT_DAP_PORT = '7006'
  const spec = resolveAdapter(GODOT_DAP_ADAPTER_KEY)
  check('godot adapter resolves when armed', spec !== null)
  check('godot in knownAdapterKeys', knownAdapterKeys().includes(GODOT_DAP_ADAPTER_KEY))
  if (spec) {
    check(
      'adapter spawns the bridge at the DAP port',
      spec.command === process.execPath && (spec.args ?? []).includes('127.0.0.1:7006'),
    )
    check('adapter has buildLaunchArgs', typeof spec.buildLaunchArgs === 'function')
    if (spec.buildLaunchArgs) {
      const full = spec.buildLaunchArgs({
        program: proj,
        args: ['current', '--speed=2'],
        cwd: proj,
      })
      check(
        'launch args speak {project, scene, playArgs}',
        full.project === proj &&
          full.scene === 'current' &&
          Array.isArray(full.playArgs) &&
          (full.playArgs as string[])[0] === '--speed=2' &&
          full.noDebug === false,
      )
      const viaFile = spec.buildLaunchArgs({
        program: path.join(proj, 'project.godot'),
        args: undefined,
        cwd: proj,
      })
      check(
        'project.godot path → project root; scene defaults to main; no playArgs key',
        viaFile.project === proj && viaFile.scene === 'main' && !('playArgs' in viaFile),
      )
    }
  }
  delete process.env.MERCURY_GODOT_DAP_PORT
}

section('§7 · registry honesty')
{
  const registry = readFileSync(path.join(repo, 'src/substrate/flagRegistry.ts'), 'utf8')
  check(
    'flagRegistry: MERCURY_GODOT opt-in row with this proof as evidence',
    registry.includes("env: 'MERCURY_GODOT'") &&
      registry.includes('scripts/lsp/prove-godot-lane.ts'),
  )
  check(
    'flagRegistry: port + bridge-entry value rows',
    registry.includes("env: 'MERCURY_GODOT_LSP_PORT'") &&
      registry.includes("env: 'MERCURY_GODOT_DAP_PORT'") &&
      registry.includes("env: 'MERCURY_TCP_BRIDGE_ENTRY'"),
  )
  const reg = readFileSync(path.join(repo, 'src/substrate/flagRegistry.ts'), 'utf8')
  check('the flag registry carries the MERCURY_GODOT legacy alias', reg.includes('MERCURY_GODOT'))
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.error(`❌ ${failures} GODOT-LANE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL GODOT-LANE PROOFS PASS')
