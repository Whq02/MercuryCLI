#!/usr/bin/env bun
// prove-compile-cache — the two boot levers.
//
//   §1 THE COMPILE CACHE, mechanism-proved on a synthetic 20MB ESM (the
//      STATE.md §4 recipe — never by executing a copied product bundle):
//      run 1 under NODE_COMPILE_CACHE populates the cache dir; run 2 reuses
//      it (no growth, no rewrite). Timings print as INFORMATION — the
//      assertions are deterministic artifacts, never wall-clock windows
//      (the granted-time law; the audited field delta was ≈689ms/boot of
//      parse on the 20.83MB bundle).
//   §2 THE PERSISTED-RULE CAP: a one-shot mega-command "always allow" stays
//      session-scoped — the durable settings write skips serialized allow
//      rules over the cap (the field home carried three ~1KB verbatim
//      command approvals, persisted forever); small allow rules persist;
//      oversized DENY rules still persist (safety-positive).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

// ── §1 the compile cache on a synthetic 20MB ESM ────────────────────────────
section('§1 COMPILE CACHE (synthetic 20MB ESM, the STATE.md §4 recipe)')
{
  const SCRATCH = mkdtempSync(join(tmpdir(), 'compile-cache-'))
  const cacheDir = join(SCRATCH, 'compile-cache')
  const synthetic = join(SCRATCH, 'synthetic.mjs')

  // Deterministic ~20MB of real parseable ESM: many distinct functions with
  // string payloads (forces genuine parse work, zero runtime cost).
  const chunk = (i: number): string =>
    `export function fn_${i}(a_${i}, b_${i}) {\n` +
    `  const s_${i} = ${JSON.stringify('payload-' + i + '-' + 'x'.repeat(160))};\n` +
    `  if (a_${i} === b_${i}) { return s_${i}.length + ${i}; }\n` +
    `  return a_${i} > b_${i} ? s_${i}.slice(${i % 100}) : String(b_${i});\n` +
    `}\n`
  const parts: string[] = []
  let bytes = 0
  for (let i = 0; bytes < 20 * 1024 * 1024; i++) {
    const c = chunk(i)
    parts.push(c)
    bytes += c.length
  }
  parts.push('export const settled = true\n')
  writeFileSync(synthetic, parts.join(''))
  const sizeMb = (statSync(synthetic).size / 1024 / 1024).toFixed(1)

  const runOnce = (): number => {
    // Presence alone of NODE_DISABLE_COMPILE_CACHE disables — build the env
    // WITHOUT it (deleting, never setting empty).
    const env = { ...process.env, NODE_COMPILE_CACHE: cacheDir }
    delete (env as Record<string, unknown>).NODE_DISABLE_COMPILE_CACHE
    const t0 = performance.now()
    execFileSync(process.execPath.includes('bun') ? 'node' : process.execPath, [synthetic], {
      env,
      stdio: 'pipe',
      timeout: 120_000,
    })
    return performance.now() - t0
  }

  const cacheFiles = (): Array<{ name: string; mtimeMs: number; size: number }> => {
    const out: Array<{ name: string; mtimeMs: number; size: number }> = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else {
          const s = statSync(p)
          out.push({ name: p.slice(cacheDir.length), mtimeMs: s.mtimeMs, size: s.size })
        }
      }
    }
    if (existsSync(cacheDir)) walk(cacheDir)
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  const t1 = runOnce()
  const after1 = cacheFiles()
  check(`run 1 populated the cache dir (${sizeMb}MB module)`, after1.length >= 1 && after1.some(f => f.size > 0), `${after1.length} file(s)`)

  const t2 = runOnce()
  const after2 = cacheFiles()
  check(
    'run 2 REUSED the cache (same file set, nothing rewritten)',
    after2.length === after1.length &&
      after2.every((f, i) => f.name === after1[i]!.name && f.mtimeMs === after1[i]!.mtimeMs),
    `files ${after1.length}→${after2.length}`,
  )
  console.log(
    `  [info] cold ${Math.round(t1)}ms → cached ${Math.round(t2)}ms (informational — the field delta was ≈689ms parse/boot on the HDD host)`,
  )
  rmSync(SCRATCH, { recursive: true, force: true })
}

// ── §2 the persisted-rule cap ───────────────────────────────────────────────
section('§2 PERSISTED-RULE CAP (mega-command approvals stay session-scoped)')
{
  const HOME = mkdtempSync(join(tmpdir(), 'rule-cap-'))
  process.env.MERCURY_CONFIG_DIR = HOME
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

  const { addPermissionRulesToSettings, MAX_PERSISTED_ALLOW_RULE_LENGTH } = await import(
    '../../src/utils/permissions/permissionsLoader.ts'
  )

  const settingsRaw = (): string => {
    const p = join(HOME, 'settings.json')
    return existsSync(p) ? readFileSync(p, 'utf8') : '{}'
  }

  const mega = `Bash(${'x'.repeat(1024)})`
  const small = 'Bash(npm run build:*)'
  const megaOk = addPermissionRulesToSettings(
    { ruleValues: [{ toolName: 'Bash', ruleContent: 'x'.repeat(1024) }], ruleBehavior: 'allow' },
    'userSettings',
  )
  check(
    'a ~1KB allow rule reports success but persists NOTHING (session-scoped)',
    megaOk === true && !settingsRaw().includes('xxxxxxxxxx'),
    `settings ${settingsRaw().length} bytes`,
  )
  check('the cap is declared and generous for real patterns', MAX_PERSISTED_ALLOW_RULE_LENGTH >= small.length * 2)

  addPermissionRulesToSettings(
    { ruleValues: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }], ruleBehavior: 'allow' },
    'userSettings',
  )
  check('a genuine reusable pattern persists', settingsRaw().includes('npm run build:*'))

  addPermissionRulesToSettings(
    { ruleValues: [{ toolName: 'Bash', ruleContent: 'y'.repeat(1024) }], ruleBehavior: 'deny' },
    'userSettings',
  )
  check('an oversized DENY still persists (safety-positive, exempt from the cap)', settingsRaw().includes('yyyyyyyyyy'))

  const mixed = addPermissionRulesToSettings(
    {
      ruleValues: [
        { toolName: 'Bash', ruleContent: 'z'.repeat(1024) },
        { toolName: 'Bash', ruleContent: 'git status' },
      ],
      ruleBehavior: 'allow',
    },
    'userSettings',
  )
  check(
    'a mixed batch persists the small rule and skips the mega one',
    mixed === true && settingsRaw().includes('git status') && !settingsRaw().includes('zzzzzzzzzz'),
  )
  rmSync(HOME, { recursive: true, force: true })
}

// ── §3 the long-home guard (TASK-014 w1-f15-01) ────────────────────────────
section('§3 THE LONG-HOME GUARD — a 224-char Windows home never starts without it')
{
  const { compileCacheDirUsable, WIN32_COMPILE_CACHE_DIR_MAX } = await import('../../src/utils/runtime/compileCachePath.ts')
  const home = 'C:\\Users\\op\\' + 'x'.repeat(224 - 'C:\\Users\\op\\'.length)
  const cacheDir = home + '\\compile-cache'
  check('the field shape (a 224-char home) is refused on win32', compileCacheDirUsable(cacheDir, 'win32') === false, String(cacheDir.length))
  check('a short win32 home is usable', compileCacheDirUsable('C:\\Users\\op\\.mercury\\compile-cache', 'win32') === true)
  check('the bound is inclusive at the constant', compileCacheDirUsable('C'.repeat(WIN32_COMPILE_CACHE_DIR_MAX), 'win32') === true && compileCacheDirUsable('C'.repeat(WIN32_COMPILE_CACHE_DIR_MAX + 1), 'win32') === false)
  check('an extended-length spelling opts out of the bound', compileCacheDirUsable('\\\\?\\' + 'C:\\' + 'y'.repeat(300), 'win32') === true)
  check('off win32 the guard never refuses', compileCacheDirUsable('/' + 'z'.repeat(400), 'darwin') === true && compileCacheDirUsable('/' + 'z'.repeat(400), 'linux') === true)
  const cli = readFileSync(join(import.meta.dir, '..', '..', 'src', 'entrypoints', 'cli.tsx'), 'utf8')
  const seam = cli.slice(cli.indexOf('resolveCompileCacheHome()'), cli.indexOf('// 6 — Windows console UTF-8'))
  check('the boot seam consults the guard before enabling the cache', seam.indexOf('compileCacheDirUsable(cacheDir)') !== -1 && seam.indexOf('compileCacheDirUsable(cacheDir)') < seam.indexOf('enableCompileCache(cacheDir)'))
  check('the guard rides a dynamic import (the seam stays zero-import until it engages)', seam.includes("await import('../utils/runtime/compileCachePath.js')"))

  // §3b the unavailable-volume probe (FC-012): a config home on a volume
  // that is not there (Q:\ never mounted) passed the length guard and
  // reached enableCompileCache, whose machinery spun one core forever — the
  // second directory Node does not no-op on. The seam now proves the cache
  // dir CREATABLE (mkdirSync) between the guard and the enable; a throw
  // lands in the arm's own catch (the lever skipped, never the boot risked).
  check(
    'the guard, the probe, and the enable are all present (rot-proof anchor)',
    seam.includes('compileCacheDirUsable(cacheDir)') &&
      seam.includes('mkdirSync(cacheDir, { recursive: true })') &&
      seam.includes('enableCompileCache(cacheDir)'),
  )
  check(
    'the seam probes creatability between the guard and the enable (FC-012)',
    seam.indexOf('mkdirSync(cacheDir, { recursive: true })') > seam.indexOf('compileCacheDirUsable(cacheDir)') &&
      seam.indexOf('mkdirSync(cacheDir, { recursive: true })') < seam.indexOf('enableCompileCache(cacheDir)'),
  )
  // (No live leg: the unavailable-volume spin is win32-only — drive
  // letters; the probe above is platform-neutral by construction.)
}

// ── §4 the export to children (FN-020 row 6) ────────────────────────────────
// The runtime enables the cache for the calling process only: the API reads
// NODE_COMPILE_CACHE and never sets it, so every self-spawn of an env-less
// boot (the owned daemon, the runners it spawns for its detached lifetime,
// both LSP sidecars) re-parsed the whole bundle uncached. The boot seam now
// exports the directory the enable took. Both arms drive the REAL runtime.
section('§4 THE EXPORT TO CHILDREN — the API never sets the env; the boot seam does')
{
  const SCRATCH = mkdtempSync(join(tmpdir(), 'compile-cache-export-'))
  const cacheDir = join(SCRATCH, 'compile-cache')
  const nodeBin = process.execPath.includes('bun') ? 'node' : process.execPath
  const env = { ...process.env }
  delete (env as Record<string, unknown>).NODE_COMPILE_CACHE
  delete (env as Record<string, unknown>).NODE_DISABLE_COMPILE_CACHE
  const probe = (script: string): Record<string, unknown> =>
    JSON.parse(
      execFileSync(nodeBin, ['-e', script, '--', cacheDir], { env, stdio: 'pipe', timeout: 60_000, encoding: 'utf8' }).trim().split('\n').pop() ?? '{}',
    ) as Record<string, unknown>
  const childProbe = `cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.NODE_COMPILE_CACHE ?? ""))'], { encoding: 'utf8' })`
  // BEFORE — the mechanism the packet read at the source, driven live.
  const before = probe(`
    const m = require('node:module'); const cp = require('node:child_process');
    const r = m.enableCompileCache(process.argv[1]);
    const child = ${childProbe};
    console.log(JSON.stringify({ enabled: r.status === m.constants.compileCacheStatus.ENABLED, envAfterEnable: process.env.NODE_COMPILE_CACHE ?? null, childSees: child }))
  `)
  check('the runtime enables the cache in-process', before.enabled === true, JSON.stringify(before))
  check('BEFORE: enableCompileCache never exports NODE_COMPILE_CACHE — the child of an env-less boot sees nothing', before.envAfterEnable === null && before.childSees === '', JSON.stringify(before))
  // AFTER — the seam's spelling: the same enable followed by the export.
  const after = probe(`
    const m = require('node:module'); const cp = require('node:child_process');
    const r = m.enableCompileCache(process.argv[1]);
    if (r.status === m.constants.compileCacheStatus.ENABLED) process.env.NODE_COMPILE_CACHE = r.directory ?? process.argv[1];
    const child = ${childProbe};
    console.log(JSON.stringify({ exported: process.env.NODE_COMPILE_CACHE ?? null, childSees: child }))
  `)
  check('AFTER: the export hands the child the directory the enable took', typeof after.childSees === 'string' && after.childSees !== '' && after.childSees === after.exported, JSON.stringify(after))
  console.log(`  BEFORE: children of an env-less boot inherit no compile cache (every self-spawn re-parses the bundle) · AFTER: they inherit ${String(after.childSees)}`)
  rmSync(SCRATCH, { recursive: true, force: true })
  // The seam: the export follows the enable, gated on the ENABLED status,
  // inside the operator-wins guard.
  const cli = readFileSync(join(import.meta.dir, '..', '..', 'src', 'entrypoints', 'cli.tsx'), 'utf8')
  const seam = cli.slice(cli.indexOf('resolveCompileCacheHome()'), cli.indexOf('// 6 — Windows console UTF-8'))
  check(
    'the seam exports the directory the enable took, gated on the ENABLED status',
    /const enabled = enableCompileCache\(cacheDir\)[\s\S]{0,900}?if \(enabled\.status === moduleConstants\.compileCacheStatus\.ENABLED\) \{\n\s*process\.env\.NODE_COMPILE_CACHE = enabled\.directory \?\? cacheDir\n\s*\}/.test(seam),
  )
  // The guard opens BEFORE the seam slice (it wraps the whole arm), so the
  // ordering reads over the file: guard, then enable, then export.
  const guardAt = cli.indexOf('process.env.NODE_COMPILE_CACHE === undefined')
  const disableGuardAt = cli.indexOf('process.env.NODE_DISABLE_COMPILE_CACHE === undefined')
  const exportAt = cli.indexOf('process.env.NODE_COMPILE_CACHE = enabled.directory')
  check(
    'the export sits inside the operator-wins guard (NODE_COMPILE_CACHE undefined, no disable switch)',
    guardAt !== -1 && disableGuardAt !== -1 && exportAt !== -1 && guardAt < exportAt && disableGuardAt < exportAt && cli.indexOf('enableCompileCache(cacheDir)') < exportAt,
  )
}

if (failures > 0) {
  console.error(`\nprove-compile-cache: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-compile-cache: all green')
