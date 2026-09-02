#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-canonical-write-home.ts — ER-3: native Mercury
//  writes land under `.mercury/`, never through into another dir.
//
//  The guarded class: a write resolver that honours some other directory
//  as a store, so Mercury-native state lands outside `.mercury/`.
//  adoptiveProjectPath (utils/projectStoreAdoption.ts) is the one write
//  resolver.
//
//  The fixed contract this prover pins:
//    §A fresh project → canonical `.mercury/<p>`, and resolving creates nothing;
//    §B an external `.claude/` store is never read, never copied;
//    §D idempotent — the same canonical answer on every call;
//    §E the compat 'state' facet OFF changes nothing (canonical-only either way);
//    §F a `.mercury` that is an alias into `.claude` is refused before any write;
//    §G the global config monolith is Mercury-named in a fresh home.
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const { adoptiveProjectPath } = await import('../../src/utils/projectStoreAdoption.js')
const { MERCURY_PROJECT_DIR } = await import('../../src/utils/projectConfig.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const inMercury = (p: string, root: string): boolean =>
  p.startsWith(join(root, MERCURY_PROJECT_DIR) + sep) || p === join(root, MERCURY_PROJECT_DIR)

section('§A fresh project resolves canonical')
{
  const root = mkdtempSync(join(tmpdir(), 'idiom-home-fresh-'))
  const p = adoptiveProjectPath(root, 'tasks')
  check('fresh project write home is .mercury', inMercury(p, root), p)
  check('resolving creates nothing', !existsSync(join(root, MERCURY_PROJECT_DIR)))
}

section('§B external .claude dir: never a home, never read')
{
  const root = mkdtempSync(join(tmpdir(), 'idiom-home-claude-'))
  const srcDir = join(root, '.claude', 'tasks')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'existing.json'), '{"t":1}\n')
  const before = statSync(join(srcDir, 'existing.json'))

  const p = adoptiveProjectPath(root, 'tasks')
  check('resolves canonical .mercury', inMercury(p, root), p)
  check('external content NOT copied (never read)', !existsSync(join(p, 'existing.json')))
  const after = statSync(join(srcDir, 'existing.json'))
  check('external bytes + mtime untouched', readFileSync(join(srcDir, 'existing.json'), 'utf8') === '{"t":1}\n' && before.mtimeMs === after.mtimeMs)
  check('no receipt file appears', !existsSync(join(root, MERCURY_PROJECT_DIR, 'state-adoptions.jsonl')))
}

section('§D idempotence — the same canonical answer on every call')
{
  const root = mkdtempSync(join(tmpdir(), 'idiom-home-idem-'))
  const p1 = adoptiveProjectPath(root, 'verify')
  mkdirSync(p1, { recursive: true })
  writeFileSync(join(p1, 'evidence.json'), '{"canonical":true}')
  const p2 = adoptiveProjectPath(root, 'verify')
  check('second call returns the same canonical home', p1 === p2)
  check('canonical content stands', readFileSync(join(p2, 'evidence.json'), 'utf8') === '{"canonical":true}')
}

section("§E compat 'state' facet OFF — canonical-only, zero I/O")
{
  const root = mkdtempSync(join(tmpdir(), 'idiom-home-off-'))
  mkdirSync(join(root, '.claude', 'tasks'), { recursive: true })
  writeFileSync(join(root, '.claude', 'tasks', 'x.json'), '{}')
  process.env.MERCURY_CC_COMPAT_STATE = 'off'
  try {
    const p = adoptiveProjectPath(root, 'tasks')
    check('resolves canonical', inMercury(p, root), p)
    check('nothing is written or copied', !existsSync(p))
  } finally {
    delete process.env.MERCURY_CC_COMPAT_STATE
  }
}

section('§F alias write-through refusal (D11): .mercury linked into .claude')
{
  const { symlinkSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'idiom-home-alias-'))
  mkdirSync(join(root, '.claude'), { recursive: true })
  try {
    // A junction on Windows, a symlink elsewhere — either way .mercury IS .claude.
    symlinkSync(join(root, '.claude'), join(root, MERCURY_PROJECT_DIR), 'junction')
    let threw = false
    try {
      adoptiveProjectPath(root, 'tasks')
    } catch (e) {
      threw = (e as Error).name === 'CanonicalRootAliasError'
    }
    check('typed CanonicalRootAliasError raised before any write', threw)
    check('nothing was written through the alias', !existsSync(join(root, '.claude', 'tasks')))
  } catch (e) {
    check('symlink fixture creatable on this host', false, String(e))
  }
}

section('§G global config monolith is Mercury-named (C2)')
{
  const probe = (home: string): string =>
    new TextDecoder()
      .decode(
        Bun.spawnSync(
          ['bun', '-e', "const {getGlobalMercuryFile}=await import('./src/utils/env.js');console.log(getGlobalMercuryFile())"],
          { env: { ...process.env, MERCURY_CONFIG_DIR: home }, cwd: process.cwd() },
        ).stdout,
      )
      .trim()

  const fresh = mkdtempSync(join(tmpdir(), 'idiom-c2-fresh-'))
  const p1 = probe(fresh)
  check('fresh home resolves the Mercury-named monolith', p1.endsWith('.mercury.json'), p1)

  const legacyHome = mkdtempSync(join(tmpdir(), 'idiom-c2-legacy-'))
  writeFileSync(join(legacyHome, '.config.json'), '{"numStartups":7}')
  const p2 = probe(legacyHome)
  check('an existing .config.json is honored IN PLACE (no copy)', p2.endsWith('.config.json'), p2)
  check('no canonical copy minted beside it', !existsSync(join(legacyHome, '.mercury.json')))

  const externalHome = mkdtempSync(join(tmpdir(), 'idiom-c2-external-'))
  writeFileSync(join(externalHome, '.claude.json'), '{"numStartups":7}')
  const p3 = probe(externalHome)
  check('an external .claude.json is IGNORED: canonical returned', p3.endsWith('.mercury.json'), p3)
  check('nothing copied from the external file', !existsSync(join(externalHome, '.mercury.json')))
  check('the external file is untouched', readFileSync(join(externalHome, '.claude.json'), 'utf8') === '{"numStartups":7}')
}

console.log(failures === 0 ? '\n ✅ CANONICAL WRITE HOME PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
