#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-godot-session.ts
//  PROOF: the fused Godot IDE session projection (ide —
//  services/ide/godotSession.ts).
//
//    (A) IDENTITY — project.godot [application] parsing: config/name +
//        run/main_scene (res:// resolved to an existing absolute path;
//        uid:// kept verbatim, never fake-resolved); escaped names.
//    (B) DISCOVERY — launch profiles execute NOTHING: main-first order,
//        the *.tscn walk is deterministic (two runs byte-equal), capped at
//        50 with an HONEST truncation count, and the editor-private .godot
//        dir never leaks a profile.
//    (C) DISARMED HONESTY — unset flags read as `disarmed` NAMING the exact
//        arm surface (boot-menu row + env), the editor block reads
//        'unavailable (VULCAN disarmed)', and nothing throws.
//    (D) VULCAN-ABSENT HONESTY — armed + no editor ⇒ 'unreachable' with the
//        teaching hint inside 1s (the 400ms probe bound), and the projection
//        WRITES NOTHING into the project (no token file on the unreachable
//        path).
//    (E) OWNERSHIP — a fresh OwnerKey sees an empty godot DAP session list
//        (the owner-scoped listing contract).
//    (F) NO-DUPLICATION PIN — the projection module constructs no TCP/
//        WebSocket/socket client and spawns nothing: it consumes the
//        existing lane/adapter/client surfaces ONLY.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-godot-session.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

// Clean slate for every flag/port this proof drives; restored at the end.
const DRIVEN = [
  'MERCURY_GODOT',
  'MERCURY_GODOT_TOOLS',
  'MERCURY_GODOT_TOOLS_PORT',
  'MERCURY_GODOT_LSP_PORT',
  'MERCURY_GODOT_DAP_PORT',
  'MERCURY_TCP_BRIDGE_ENTRY',
  'MERCURY_DAP_ADAPTERS',
] as const
const savedEnv = { ...process.env }
function restoreEnv(): void {
  for (const k of DRIVEN) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}
for (const k of DRIVEN) delete process.env[k]

const godot = await import('../../src/services/ide/godotSession.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')

/** A loopback port with NOTHING listening (bind :0, note the port, close). */
async function freePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port > 0 ? res(port) : rej(new Error('no port'))))
    })
    srv.once('error', rej)
  })
}

console.log('============================================================')
console.log(' godot session projection — identity · discovery · honesty')
console.log('============================================================')

const arena = mkdtempSync(join(tmpdir(), 'godot-session-'))
try {
  // The fixture project: named, main-scened, 58 scenes (50-cap + 8 over),
  // plus an editor-private .godot scene that must NEVER surface.
  const proj = join(arena, 'game')
  mkdirSync(join(proj, 'scenes'), { recursive: true })
  mkdirSync(join(proj, 'levels'), { recursive: true })
  mkdirSync(join(proj, '.godot'), { recursive: true })
  writeFileSync(
    join(proj, 'project.godot'),
    [
      'config_version=5',
      '',
      '[application]',
      '',
      'config/name="Fixture \\"Game\\""',
      'run/main_scene="res://scenes/Main.tscn"',
      '',
      '[rendering]',
      '',
      'renderer/rendering_method="mobile"',
      '',
    ].join('\n'),
  )
  writeFileSync(join(proj, 'scenes', 'Main.tscn'), '[gd_scene format=3]\n')
  for (let i = 0; i < 30; i++) {
    writeFileSync(join(proj, 'scenes', `s${String(i).padStart(2, '0')}.tscn`), '[gd_scene]\n')
  }
  for (let i = 0; i < 27; i++) {
    writeFileSync(join(proj, 'levels', `l${String(i).padStart(2, '0')}.tscn`), '[gd_scene]\n')
  }
  writeFileSync(join(proj, '.godot', 'cached.tscn'), '[gd_scene]\n')
  const TOTAL_SCENES = 1 + 30 + 27 // Main + scenes + levels (.godot excluded)

  section('(A) project.godot identity parsing')
  {
    godot._resetGodotSessionForTesting()
    const parsed = godot.parseGodotProjectFile(proj)
    check('A1 config/name parsed (escapes unwrapped)', parsed.name === 'Fixture "Game"', JSON.stringify(parsed))
    check('A2 run/main_scene parsed verbatim', parsed.mainScene === 'res://scenes/Main.tscn', JSON.stringify(parsed))

    const owner = makeOwnerKey({ workspace: proj, sessionId: 'godot-proof-a', lane: 'main' })
    const session = await godot.buildGodotIdeSession(owner, join(proj, 'levels'))
    check('A3 root found by walk-up from a subdir', session.project.state === 'ok' && session.project.root === proj, JSON.stringify(session.project).slice(0, 160))
    check(
      'A4 main scene resolves to the existing absolute path',
      session.project.state === 'ok' && session.project.mainScenePath === join(proj, 'scenes', 'Main.tscn'),
      JSON.stringify(session.project).slice(0, 200),
    )

    // uid:// main scenes stay verbatim — the editor owns that mapping.
    const uidProj = join(arena, 'uid-game')
    mkdirSync(uidProj, { recursive: true })
    writeFileSync(
      join(uidProj, 'project.godot'),
      '[application]\n\nconfig/name="Uid"\nrun/main_scene="uid://abc123"\n',
    )
    godot._resetGodotSessionForTesting()
    const uidSession = await godot.buildGodotIdeSession(owner, uidProj)
    check(
      'A5 uid:// main scene kept verbatim, never fake-resolved',
      uidSession.project.state === 'ok' &&
        uidSession.project.mainScene === 'uid://abc123' &&
        uidSession.project.mainScenePath === undefined,
      JSON.stringify(uidSession.project).slice(0, 200),
    )

    const bare = join(arena, 'bare')
    mkdirSync(bare, { recursive: true })
    const absent = await godot.buildGodotIdeSession(owner, bare)
    check('A6 no project.godot ⇒ honest absent (never a throw)', absent.project.state === 'absent' && absent.project.detail.includes('no project.godot'), JSON.stringify(absent.project))
  }

  section('(B) launch-profile discovery — bounded, deterministic, executes nothing')
  {
    godot._resetGodotSessionForTesting()
    const d1 = await godot.discoverGodotLaunchProfiles(proj)
    const d2 = await godot.discoverGodotLaunchProfiles(proj)
    check('B1 deterministic (two runs identical)', JSON.stringify(d1) === JSON.stringify(d2))
    check('B2 main profile first, from run/main_scene', d1.profiles[0]?.kind === 'main' && d1.profiles[0]?.scene === 'res://scenes/Main.tscn', JSON.stringify(d1.profiles[0]))
    check('B3 no current profile without VULCAN', d1.profiles.every(p => p.kind !== 'current'))
    const sceneProfiles = d1.profiles.filter(p => p.kind === 'scene')
    check('B4 scene walk capped at 50', sceneProfiles.length === 50, String(sceneProfiles.length))
    check('B5 honest totals: sceneCount + truncation', d1.sceneCount === TOTAL_SCENES && d1.truncatedScenes === TOTAL_SCENES - 50, `count=${d1.sceneCount} truncated=${d1.truncatedScenes}`)
    check('B6 editor-private .godot never leaks a profile', d1.profiles.every(p => !p.scene.includes('.godot')))
    const ordered = sceneProfiles.map(p => p.scene)
    check('B7 lexicographic order (levels/ before scenes/)', ordered[0] === 'res://levels/l00.tscn' && [...ordered].sort().join() === ordered.join(), ordered.slice(0, 3).join(' '))
    check('B8 resolved paths exist and stay inside the project', sceneProfiles.every(p => p.path !== undefined && p.path.startsWith(proj) && existsSync(p.path)))
  }

  section('(C) disarmed honesty — OFF flags are states, not errors')
  {
    const owner = makeOwnerKey({ workspace: proj, sessionId: 'godot-proof-c', lane: 'main' })
    const session = await godot.buildGodotIdeSession(owner, proj)
    check(
      'C1 godot lane disarmed NAMES the arm surface (boot menu + env)',
      session.godotLane.state === 'disarmed' &&
        session.godotLane.armSurface.includes('boot menu') &&
        session.godotLane.armSurface.includes('MERCURY_GODOT=1'),
      JSON.stringify(session.godotLane),
    )
    check(
      'C2 vulcan lane disarmed NAMES the arm surface',
      session.vulcanLane.state === 'disarmed' &&
        session.vulcanLane.armSurface.includes('boot menu') &&
        session.vulcanLane.armSurface.includes('MERCURY_GODOT_TOOLS=1'),
      JSON.stringify(session.vulcanLane),
    )
    check('C3 LSP not registered, detail carries the arm surface', !session.lsp.registered && session.lsp.detail.includes('MERCURY_GODOT=1'), session.lsp.detail)
    check('C4 DAP adapter not registered, detail carries the arm surface', !session.dap.adapterRegistered && session.dap.detail.includes('MERCURY_GODOT=1'), session.dap.detail)
    check('C5 vulcan state disarmed', session.vulcan.state === 'disarmed', JSON.stringify(session.vulcan).slice(0, 160))
    check('C6 editor truth reads unavailable (VULCAN disarmed)', session.editor.state === 'unavailable' && session.editor.detail.includes('VULCAN disarmed'), JSON.stringify(session.editor).slice(0, 200))
    check('C7 ports reported even while disarmed', session.lsp.port === 6005 && session.dap.port === 6006 && session.vulcan.port === 6010)
  }

  section('(D) VULCAN-absent honesty — armed, no editor, bounded, zero writes')
  {
    const owner = makeOwnerKey({ workspace: proj, sessionId: 'godot-proof-d', lane: 'main' })

    // D1: lanes armed, VULCAN still off ⇒ the editor block blames VULCAN.
    process.env.MERCURY_GODOT = '1'
    const lanesOnly = await godot.buildGodotIdeSession(owner, proj)
    check('D1 lanes armed + VULCAN off ⇒ editor unavailable names VULCAN disarmed', lanesOnly.godotLane.state === 'armed' && lanesOnly.editor.state === 'unavailable' && lanesOnly.editor.detail.includes('VULCAN disarmed'), JSON.stringify(lanesOnly.editor).slice(0, 200))
    check('D2 armed flag re-read LIVE (no reset needed)', lanesOnly.godotLane.state === 'armed')

    // D3+: VULCAN armed against a port nothing listens on.
    process.env.MERCURY_GODOT_TOOLS = '1'
    process.env.MERCURY_GODOT_TOOLS_PORT = String(await freePort())
    const t0 = Date.now()
    const unreachable = await godot.buildGodotIdeSession(owner, proj)
    const elapsed = Date.now() - t0
    check(
      'D3 no editor ⇒ vulcan unreachable with the teaching hint',
      unreachable.vulcan.state === 'unreachable' && unreachable.vulcan.detail.includes('Godot editor running'),
      JSON.stringify(unreachable.vulcan).slice(0, 240),
    )
    check('D4 editor truth reads unavailable (VULCAN editor unreachable)', unreachable.editor.state === 'unavailable' && unreachable.editor.detail.includes('unreachable'), JSON.stringify(unreachable.editor).slice(0, 200))
    check('D5 the unreachable path is BOUNDED (<3s; probe bound is 400ms)', elapsed < 3_000, `${elapsed}ms`)
    check('D6 addon truth from the existing probe: not installed', unreachable.vulcan.state === 'unreachable' && unreachable.vulcan.addon.installed === false)
    check('D7 the projection writes NOTHING (no token file on unreachable)', !existsSync(join(proj, '.godot', 'mercury-vulcan-token')))
    check('D8 discovery still yields no current profile (editor absent)', (await godot.discoverGodotLaunchProfiles(proj)).profiles.every(p => p.kind !== 'current'))

    delete process.env.MERCURY_GODOT
    delete process.env.MERCURY_GODOT_TOOLS
    delete process.env.MERCURY_GODOT_TOOLS_PORT
  }

  section('(E) owner-scoped DAP listing')
  {
    const fresh = makeOwnerKey({ workspace: proj, sessionId: `godot-proof-e-${Date.now()}`, lane: 'main' })
    const session = await godot.buildGodotIdeSession(fresh, proj)
    check('E1 a fresh owner sees an empty godot session list', Array.isArray(session.dap.sessions) && session.dap.sessions.length === 0, JSON.stringify(session.dap.sessions))
  }

  section('(F) NO-DUPLICATION pin — the projection consumes, never re-implements')
  {
    const src = readFileSync(join(ROOT, 'src', 'services', 'ide', 'godotSession.ts'), 'utf8')
    const forbidden: Array<[string, RegExp]> = [
      ['node:net import (transport belongs to the lanes/client)', /from 'node:net'|require\(['"]node:net/],
      ['node:tls import', /from 'node:tls'/],
      ['raw socket construction', /net\.connect|createConnection|new Socket\(/],
      ['WebSocket construction', /new WebSocket|from 'ws'/],
      ['child spawn (the projection executes nothing)', /spawnSync?\(|from 'node:child_process'/],
      ['a second VulcanClient (the singleton is the client)', /new VulcanClient\(/],
      ['a second DAP session (createDapSession is the launch path)', /createDapSession\(/],
    ]
    for (const [label, re] of forbidden) {
      check(`F: no ${label}`, !re.test(src), String(re))
    }
    const consumed = [
      'findGodotProjectRoot',
      'probeGodotEditorReachable',
      'vulcanInstallStatus',
      'getVulcanClient',
      'listDapSessions',
      'resolveAdapter',
      'builtinGodotServer',
      'getLspServerManager',
    ]
    for (const name of consumed) {
      check(`F: consumes the existing ${name}`, src.includes(name))
    }
  }
} finally {
  restoreEnv()
  rmSync(arena, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL GODOT SESSION-PROJECTION CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
