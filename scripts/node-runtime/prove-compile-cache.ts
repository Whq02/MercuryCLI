#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 COMPILE CACHE (synthetic 20MB ESM, the STATE.md §4 recipe)')
{
  const SCRATCH = mkdtempSync(join(tmpdir(), 'compile-cache-'))
  const cacheDir = join(SCRATCH, 'compile-cache')
  const synthetic = join(SCRATCH, 'synthetic.mjs')

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
  check(`run 1 populated the cache dir (${sizeMb}MB module)`, after1.length >= 1 && after1.some(f => f.size > 0), `${after1.length} file(s)`, 'node did not write a compile cache for the synthetic module: check that this node is 22.1 or later and that NODE_COMPILE_CACHE points at a writable directory')

  const t2 = runOnce()
  const after2 = cacheFiles()
  check(
    'run 2 REUSED the cache (same file set, nothing rewritten)',
    after2.length === after1.length &&
      after2.every((f, i) => f.name === after1[i]!.name && f.mtimeMs === after1[i]!.mtimeMs),
    `files ${after1.length}→${after2.length}`,
    'the second run rewrote or added cache files: check that NODE_COMPILE_CACHE is stable between runs and that nothing else touches the cache directory',
  )
  console.log(
    `  [info] cold ${Math.round(t1)}ms → cached ${Math.round(t2)}ms (informational — the field delta was ≈689ms parse/boot on the HDD host)`,
  )
  rmSync(SCRATCH, { recursive: true, force: true })
}

section('§2 PERSISTED-RULE CAP (mega-command approvals stay session-scoped)')
{
  const HOME = mkdtempSync(join(tmpdir(), 'rule-cap-'))
  process.env.MERCURY_CONFIG_DIR = HOME
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

  const { addPermissionRulesToSettings, MAX_PERSISTED_ALLOW_RULE_LENGTH } = await import(
    '../../src/permissions/rules/permissionsLoader.ts'
  )

  const settingsRaw = (): string => {
    const p = join(HOME, 'settings.json')
    return existsSync(p) ? readFileSync(p, 'utf8') : '{}'
  }

  const mega = `Bash(${'x'.repeat(1024)})`
  const small = 'Bash(npm run build *)'
  const megaOk = addPermissionRulesToSettings(
    { ruleValues: [{ toolName: 'Bash', ruleContent: 'x'.repeat(1024) }], ruleBehavior: 'allow' },
    'userSettings',
  )
  check(
    'a ~1KB allow rule reports success but persists NOTHING (session-scoped)',
    megaOk === true && !settingsRaw().includes('xxxxxxxxxx'),
    `settings ${settingsRaw().length} bytes`,
    'change addPermissionRulesToSettings in src/permissions/rules/permissionsLoader.ts so an allow rule longer than MAX_PERSISTED_ALLOW_RULE_LENGTH is skipped on disk and the call still returns true',
  )
  check('the cap is declared and generous for real patterns', MAX_PERSISTED_ALLOW_RULE_LENGTH >= small.length * 2, '', 'raise MAX_PERSISTED_ALLOW_RULE_LENGTH in src/permissions/rules/permissionsLoader.ts to at least twice the length of an ordinary rule')

  addPermissionRulesToSettings(
    { ruleValues: [{ toolName: 'Bash', ruleContent: 'npm run build *' }], ruleBehavior: 'allow' },
    'userSettings',
  )
  check('a genuine reusable pattern persists', settingsRaw().includes('npm run build *'), '', 'addPermissionRulesToSettings in src/permissions/rules/permissionsLoader.ts must write an allow rule within the cap to the settings file')

  addPermissionRulesToSettings(
    { ruleValues: [{ toolName: 'Bash', ruleContent: 'y'.repeat(1024) }], ruleBehavior: 'deny' },
    'userSettings',
  )
  check('an oversized DENY still persists (safety-positive, exempt from the cap)', settingsRaw().includes('yyyyyyyyyy'), '', 'the length cap in addPermissionRulesToSettings (src/permissions/rules/permissionsLoader.ts) must apply to the allow behavior only')

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
    '',
    'addPermissionRulesToSettings in src/permissions/rules/permissionsLoader.ts must drop only the oversized allow rules of a batch and persist the rest',
  )
  rmSync(HOME, { recursive: true, force: true })
}

section('§3 THE LONG-HOME GUARD — a 224-char Windows home never starts without it')
{
  const { compileCacheDirUsable, WIN32_COMPILE_CACHE_DIR_MAX } = await import('../../src/platform/node-runtime/compileCachePath.ts')
  const home = 'C:\\Users\\op\\' + 'x'.repeat(224 - 'C:\\Users\\op\\'.length)
  const cacheDir = home + '\\compile-cache'
  check('the field shape (a 224-char home) is refused on win32', compileCacheDirUsable(cacheDir, 'win32') === false, String(cacheDir.length), 'compileCacheDirUsable in src/platform/node-runtime/compileCachePath.ts must return false on win32 for a directory longer than WIN32_COMPILE_CACHE_DIR_MAX')
  check('a short win32 home is usable', compileCacheDirUsable('C:\\Users\\op\\.mercury\\compile-cache', 'win32') === true, '', 'compileCacheDirUsable in src/platform/node-runtime/compileCachePath.ts must accept a win32 directory of at most WIN32_COMPILE_CACHE_DIR_MAX characters')
  check('the bound is inclusive at the constant', compileCacheDirUsable('C'.repeat(WIN32_COMPILE_CACHE_DIR_MAX), 'win32') === true && compileCacheDirUsable('C'.repeat(WIN32_COMPILE_CACHE_DIR_MAX + 1), 'win32') === false, '', 'compileCacheDirUsable in src/platform/node-runtime/compileCachePath.ts must compare the length with <= WIN32_COMPILE_CACHE_DIR_MAX')
  check('an extended-length spelling opts out of the bound', compileCacheDirUsable('\\\\?\\' + 'C:\\' + 'y'.repeat(300), 'win32') === true, '', 'compileCacheDirUsable in src/platform/node-runtime/compileCachePath.ts must return true for a path that starts with the extended-length prefix')
  check('off win32 the guard never refuses', compileCacheDirUsable('/' + 'z'.repeat(400), 'darwin') === true && compileCacheDirUsable('/' + 'z'.repeat(400), 'linux') === true, '', 'compileCacheDirUsable in src/platform/node-runtime/compileCachePath.ts must return true whenever the platform is not win32')
}

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
  const before = probe(`
    const m = require('node:module'); const cp = require('node:child_process');
    const r = m.enableCompileCache(process.argv[1]);
    const child = ${childProbe};
    console.log(JSON.stringify({ enabled: r.status === m.constants.compileCacheStatus.ENABLED, envAfterEnable: process.env.NODE_COMPILE_CACHE ?? null, childSees: child }))
  `)
  check('the runtime enables the cache in-process', before.enabled === true, JSON.stringify(before), 'module.enableCompileCache did not report ENABLED in this node: use a node that supports the compile cache')
  check('BEFORE: enableCompileCache never exports NODE_COMPILE_CACHE — the child of an env-less boot sees nothing', before.envAfterEnable === null && before.childSees === '', JSON.stringify(before), 'this node now exports NODE_COMPILE_CACHE itself on enable: the boot seam that exports it to children may no longer be needed')
  const after = probe(`
    const m = require('node:module'); const cp = require('node:child_process');
    const r = m.enableCompileCache(process.argv[1]);
    if (r.status === m.constants.compileCacheStatus.ENABLED) process.env.NODE_COMPILE_CACHE = r.directory ?? process.argv[1];
    const child = ${childProbe};
    console.log(JSON.stringify({ exported: process.env.NODE_COMPILE_CACHE ?? null, childSees: child }))
  `)
  check('AFTER: the export hands the child the directory the enable took', typeof after.childSees === 'string' && after.childSees !== '' && after.childSees === after.exported, JSON.stringify(after), 'a child process did not inherit the directory that enableCompileCache took: the boot code must set process.env.NODE_COMPILE_CACHE to that directory after a successful enable')
  console.log(`  BEFORE: children of an env-less boot inherit no compile cache (every self-spawn re-parses the bundle) · AFTER: they inherit ${String(after.childSees)}`)
  rmSync(SCRATCH, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nprove-compile-cache: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-compile-cache: all green')
