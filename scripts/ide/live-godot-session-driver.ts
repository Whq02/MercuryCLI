#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

process.env.MERCURY_HOME = mkdtempSync(path.join(tmpdir(), 'live-godot-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}


interface DriverArgs {
  mode: 'plumbing' | 'journey'
  project?: string
  scene: string
  gd?: string
  breakLine?: number
}

export function parseDriverArgs(argv: string[]): DriverArgs | { error: string } {
  const args: DriverArgs = { mode: 'plumbing', scene: 'main' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string | undefined => argv[++i]
    switch (a) {
      case '--mode': {
        const v = next()
        if (v !== 'plumbing' && v !== 'journey') return { error: `--mode must be plumbing|journey (got '${v}')` }
        args.mode = v
        break
      }
      case '--project': {
        const v = next()
        if (!v) return { error: '--project needs a directory' }
        args.project = path.resolve(v)
        break
      }
      case '--scene': {
        const v = next()
        if (!v) return { error: '--scene needs main|current|res://…' }
        args.scene = v
        break
      }
      case '--gd': {
        const v = next()
        if (!v) return { error: '--gd needs a .gd file path' }
        args.gd = path.resolve(v)
        break
      }
      case '--break-line': {
        const v = Number(next())
        if (!Number.isInteger(v) || v < 1) return { error: '--break-line needs a positive integer' }
        args.breakLine = v
        break
      }
      default:
        return { error: `unknown argument '${a}'` }
    }
  }
  return args
}

const parsed = parseDriverArgs(process.argv.slice(2))
if ('error' in parsed) {
  console.error(`live-godot-session-driver: ${parsed.error}`)
  process.exit(2)
}

const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const godot = await import('../../src/services/ide/godotSession.js')


if (parsed.mode === 'plumbing') {
  console.log('live-godot-session-driver: PLUMBING mode (no editor dialed)')
  const bad = parseDriverArgs(['--mode', 'nope'])
  check('plumbing: bad --mode is refused', 'error' in bad)
  const good = parseDriverArgs(['--mode', 'journey', '--scene', 'res://scenes/Main.tscn', '--break-line', '7'])
  check(
    'plumbing: journey args round-trip',
    !('error' in good) && good.mode === 'journey' && good.scene === 'res://scenes/Main.tscn' && good.breakLine === 7,
  )
  const arena = mkdtempSync(path.join(tmpdir(), 'godot-plumbing-'))
  try {
    mkdirSync(path.join(arena, 'game'), { recursive: true })
    writeFileSync(path.join(arena, 'game', 'project.godot'), '[application]\n\nconfig/name="Plumbing"\n')
    const owner = makeOwnerKey({ workspace: arena, sessionId: 'godot-plumbing', lane: 'main' })
    const session = await godot.buildGodotIdeSession(owner, path.join(arena, 'game'))
    check('plumbing: projection identifies the fixture project', session.project.state === 'ok' && session.project.name === 'Plumbing')
    check('plumbing: disarmed honesty holds', session.godotLane.state === 'disarmed' || session.godotLane.state === 'armed')
  } finally {
    rmSync(arena, { recursive: true, force: true })
  }
  console.log(failures === 0 ? 'live-godot-session-driver: plumbing GREEN' : 'live-godot-session-driver: plumbing RED')
  process.exit(failures === 0 ? 0 : 1)
}


if (process.env.RUN_LIVE !== '1') {
  console.log('live-godot-session-driver: journey mode needs RUN_LIVE=1 — skipping')
  process.exit(0)
}

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { findGodotProjectRoot } = await import('../../src/services/lsp/godotLane.js')
const root = findGodotProjectRoot(parsed.project ?? process.cwd())
if (!root) {
  console.error(
    `live-godot-session-driver: no project.godot from ${parsed.project ?? process.cwd()} — pass --project <godot project>`,
  )
  process.exit(1)
}
console.log(`live godot project: ${root}`)

function findFirstGd(dir: string, depth = 0): string | undefined {
  if (depth > 6) return undefined
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.gd')) return path.join(dir, e.name)
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'addons') {
      const hit = findFirstGd(path.join(dir, e.name), depth + 1)
      if (hit) return hit
    }
  }
  return undefined
}

await runWithCwdOverride(root, async () => {
  const owner = makeOwnerKey({ workspace: root, sessionId: `godot-live-${Date.now()}`, lane: 'main' })

  const before = await godot.buildGodotIdeSession(owner, root)
  console.log('\n>>> session projection (before):')
  console.log(JSON.stringify(before, null, 2))
  check('journey: godot lane armed', before.godotLane.state === 'armed', 'set MERCURY_GODOT=1')
  check('journey: mercury-godot lane registers', before.lsp.registered, before.lsp.detail)
  check('journey: the godot DAP adapter resolves', before.dap.adapterRegistered, before.dap.detail)
  if (before.vulcanLane.state === 'armed') {
    check('journey: VULCAN reachability truth', before.vulcan.state === 'reachable' || before.vulcan.state === 'unreachable')
  }

  const gdFile = parsed.gd ?? findFirstGd(root)
  if (!gdFile) {
    check('journey: a .gd file exists for the symbol leg', false, 'pass --gd <file.gd>')
  } else {
    const { createLSPServerManager } = await import('../../src/services/lsp/LSPServerManager.js')
    const { readFileSync } = await import('node:fs')
    const manager = createLSPServerManager()
    await manager.initialize()
    const server = manager.getServerForFile(gdFile)
    check('journey: mercury-godot claims .gd', server?.name === 'mercury-godot', server?.name)
    if (server) {
      const { pathToFileURL } = await import('node:url')
      await manager.openFile(gdFile, readFileSync(gdFile, 'utf8'))
      const symbols = await manager.sendRequest<unknown[]>(gdFile, 'textDocument/documentSymbol', {
        textDocument: { uri: pathToFileURL(gdFile).href },
      })
      check('journey: documentSymbol answers through the editor LSP', Array.isArray(symbols), JSON.stringify(symbols)?.slice(0, 160))
    }
    await manager.shutdown()
  }

  const { createDapSession, removeDapSession } = await import('../../src/services/dap/dapClient.js')
  const breakpoints = gdFile && parsed.breakLine ? new Map([[gdFile, [parsed.breakLine]]]) : undefined
  let launched = false
  try {
    const session = await createDapSession({
      owner,
      id: 'godot-live',
      adapterKey: 'godot',
      program: root,
      args: [parsed.scene],
      cwd: root,
      ...(breakpoints ? { breakpoints } : {}),
    })
    launched = true
    check('journey: launch succeeded (the {project, scene} contract)', session.alive)

    const during = await godot.buildGodotIdeSession(owner, root)
    check(
      'journey: projection lists the live godot session',
      during.dap.sessions.some(s => s.id === 'godot-live' && s.alive),
      JSON.stringify(during.dap.sessions),
    )

    if (breakpoints) {
      const outcome = await session.waitForStopOutcome(20_000)
      check('journey: stopped at the breakpoint', outcome.state === 'stopped', JSON.stringify(outcome))
      if (outcome.state === 'stopped' && outcome.info.threadId !== undefined) {
        const stack = await session.request('stackTrace', { threadId: outcome.info.threadId })
        const frames = Array.isArray(stack.stackFrames) ? (stack.stackFrames as Array<{ id: number; name?: string }>) : []
        check('journey: stackTrace has frames', frames.length > 0, JSON.stringify(frames.slice(0, 2)))
        if (frames[0]) {
          const scopes = await session.request('scopes', { frameId: frames[0].id })
          const scopeRows = Array.isArray(scopes.scopes) ? (scopes.scopes as Array<{ variablesReference: number }>) : []
          check('journey: scopes answer', scopeRows.length > 0)
          if (scopeRows[0]) {
            const vars = await session.request('variables', { variablesReference: scopeRows[0].variablesReference })
            check('journey: variables answer', Array.isArray(vars.variables))
          }
        }
        await session.request('continue', { threadId: outcome.info.threadId }).catch(() => {})
      }
    }

    if (before.vulcanLane.state === 'armed' && before.vulcan.state === 'reachable') {
      const { getVulcanClient } = await import('../../src/services/vulcan/vulcanClient.js')
      const client = getVulcanClient()
      if (client) {
        const tree = await client.request('runtime_tree', undefined, 15_000)
        check('journey: VULCAN runtime tree answers during play', tree.ok || tree.error.code === 'NO_RUNTIME', JSON.stringify(tree).slice(0, 200))
      }
    } else {
      console.log('  [SKIP] VULCAN runtime tree (MERCURY_GODOT_TOOLS not armed/reachable)')
    }
  } finally {
    if (launched) await removeDapSession(owner, 'godot-live')
  }
  const after = await godot.buildGodotIdeSession(owner, root)
  check(
    'journey: projection reflects the finished session (no live godot debuggee)',
    after.dap.sessions.every(s => !s.alive || s.id !== 'godot-live'),
    JSON.stringify(after.dap.sessions),
  )

  const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.js')
  await disposeOwner(owner)
})

if (failures > 0) {
  console.error(`live-godot-session-driver: RED (${failures})`)
  process.exit(1)
}
console.log('live-godot-session-driver: GREEN — the fused session against a real editor')
