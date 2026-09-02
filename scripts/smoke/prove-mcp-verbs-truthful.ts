#!/usr/bin/env bun
// prove-mcp-verbs-truthful — two mcp-verb defects on the built artifact
// (field cards FC-035 · FC-036).
//
// FC-035: `mcp remove <name>` without --scope tested membership against the
//   {servers, errors} WRAPPER, so every real server was refused ("No MCP
//   server named X is configured") while the wrapper keys servers/errors
//   were reported to exist in all three scopes.
// FC-036: `mcp add --scope project` wrote the repo-visible .mcp.json with no
//   lock: eight concurrent adds all reported success and five were silently
//   discarded; a raced remove printed Removed while the server stayed. Both
//   RMW arms now serialize under the config lock family (FC-011 retries).
//
//   §1 FC-035: scopeless remove finds and removes a real server; the wrapper
//      names are refused as unconfigured.
//   §2 FC-036: eight concurrent project adds — every success is real.
//   §3 FC-036: raced project removes/adds — every reported outcome true.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

if (!existsSync(DIST)) {
  console.error('  [FAIL] dist/mercury.mjs missing — run bun run build.ts first')
  process.exit(1)
}

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-verbs-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-verbs-proj-')))

type Run = { rc: number; out: string }
const runMercury = (args: string[]): Promise<Run> =>
  new Promise(resolve => {
    const child = spawn('node', [DIST, ...args], {
      cwd: PROJ,
      env: { ...process.env, MERCURY_CONFIG_DIR: HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (out += String(d)))
    child.on('close', rc => resolve({ rc: rc ?? -1, out }))
  })

const projectServers = (): string[] => {
  try {
    const doc = JSON.parse(readFileSync(join(PROJ, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> }
    return Object.keys(doc.mcpServers ?? {})
  } catch {
    return []
  }
}

section('§1 FC-035 — the scopeless remove')
{
  const added = await runMercury(['mcp', 'add', '--scope', 'local', 'probe_local', '--', 'echo', 'x'])
  check('fixture: a local-scope server adds', added.rc === 0, added.out.slice(0, 80))
  const removed = await runMercury(['mcp', 'remove', 'probe_local'])
  check(
    'scopeless remove FINDS the real server (FC-035)',
    removed.rc === 0 && /Removed MCP server probe_local/.test(removed.out),
    JSON.stringify({ rc: removed.rc, out: removed.out.slice(0, 120) }),
  )
  const wrapperGhost = await runMercury(['mcp', 'remove', 'servers'])
  check(
    "the wrapper key 'servers' is refused as unconfigured",
    wrapperGhost.rc !== 0 && /No MCP server named servers/.test(wrapperGhost.out),
    JSON.stringify({ rc: wrapperGhost.rc, out: wrapperGhost.out.slice(0, 120) }),
  )
}

section('§2 FC-036 — eight concurrent project adds')
{
  const runs = await Promise.all(
    Array.from({ length: 8 }, (_, i) => runMercury(['mcp', 'add', '--scope', 'project', `pj_${i + 1}`, '--', 'echo', `cmd_${i + 1}`])),
  )
  const successes = runs.filter(r => r.rc === 0 && /Added/i.test(r.out)).length
  const survivors = projectServers().filter(n => n.startsWith('pj_')).length
  check('all eight adds report success', successes === 8, `successes=${successes}`)
  check('every reported success is REAL in .mcp.json (FC-036)', survivors === 8, `survivors=${survivors}/8`)
}

section('§3 FC-036 — the raced remove/add')
{
  const raced = await Promise.all([
    runMercury(['mcp', 'remove', 'pj_1', '--scope', 'project']),
    runMercury(['mcp', 'remove', 'pj_2', '--scope', 'project']),
    runMercury(['mcp', 'remove', 'pj_3', '--scope', 'project']),
    runMercury(['mcp', 'add', '--scope', 'project', 'pj_9', '--', 'echo', 'x']),
    runMercury(['mcp', 'add', '--scope', 'project', 'pj_10', '--', 'echo', 'x']),
  ])
  const after = new Set(projectServers())
  const removedReported = raced.slice(0, 3).filter(r => r.rc === 0 && /Removed/i.test(r.out)).length
  check('the three removes report removed', removedReported === 3, `reported=${removedReported}`)
  check('a reported remove IS removed', !after.has('pj_1') && !after.has('pj_2') && !after.has('pj_3'), JSON.stringify([...after]))
  check('the raced adds are real', after.has('pj_9') && after.has('pj_10'))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-mcp-verbs-truthful: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-mcp-verbs-truthful: all green')
