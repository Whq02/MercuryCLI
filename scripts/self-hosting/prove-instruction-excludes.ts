#!/usr/bin/env bun
// ============================================================================
//  scripts/self-hosting/prove-instruction-excludes.ts — the operator's
//  instruction-exclusion law, driven end to end (settings file → schema →
//  the mercury-native adapter → the exclusion matcher → the engine walk)
//  on a scratch project with REAL symlinks.
//
//  Laws pinned here:
//    · THE SETTING is `instructionExcludes` — a settings.json carrying it
//      excludes; one carrying the retired `claudeMdExcludes` spelling
//      excludes NOTHING and still parses (root passthrough, no alias).
//    · SYMLINK-HONEST IN BOTH DIRECTIONS, file level included:
//        (a) a pattern naming a symlinked rules FILE by its symlink
//            spelling excludes the file the engine walks under its target
//            spelling (pattern-side resolution reaches the file itself);
//        (b) a pattern naming the TARGET of a symlinked root file excludes
//            the file the engine tests under its symlink spelling (the
//            tested path's realpath twin matches);
//        (c) a glob pattern under a symlinked DIRECTORY spelling excludes
//            the files walked under the target directory spelling;
//        (d) a pure glob needs no filesystem at all.
//    · NO PATTERN ⇒ EVERYTHING COMPOSES (the symlinked sources included).
//    · MANAGED IMMUNITY: the managed layer never consults the patterns —
//      the same path a matching pattern excludes for User/Project stays
//      composed for Managed.
//    · A LEADING `~` means the operator's home (the permission-rule law
//      for operator-written path rules).
//
//  Run: ~/.bun/bin/bun run scripts/self-hosting/prove-instruction-excludes.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const repo = join(import.meta.dir, '..', '..')

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── the scratch project: real files, real symlinks ──────────────────────────
// The root is realpath'd up front so the ONLY symlinks in play are the ones
// built deliberately below (macOS tmpdir itself lives behind /var → /private).
const root = realpathSync(mkdtempSync(join(tmpdir(), 'excl-prove-')))
const proj = join(root, 'proj')
const rulesDir = join(proj, '.mercury', 'rules')
const targets = join(proj, 'targets')
mkdirSync(rulesDir, { recursive: true })
mkdirSync(join(targets, 'rule-pack'), { recursive: true })

// A symlinked ROOT instruction file: the engine tests it by its symlink
// spelling (projectDirFiles constructs, never resolves).
writeFileSync(join(targets, 'ROOT-GUIDE.md'), 'root guide body\n')
symlinkSync(join(targets, 'ROOT-GUIDE.md'), join(proj, 'MERCURY.md'))

// A plain rule, a glob-bait rule, a symlinked rules FILE (the engine walks
// it under its TARGET spelling), and a symlinked rules DIRECTORY.
writeFileSync(join(rulesDir, 'real.md'), 'plain rule\n')
writeFileSync(join(rulesDir, 'secret-skip.md'), 'glob-bait rule\n')
writeFileSync(join(targets, 'actual-rule.md'), 'linked rule body\n')
symlinkSync(join(targets, 'actual-rule.md'), join(rulesDir, 'linked-file.md'))
writeFileSync(join(targets, 'rule-pack', 'packed.md'), 'packed rule body\n')
symlinkSync(join(targets, 'rule-pack'), join(rulesDir, 'linked-dir'))

// The spellings the engine composes under (see the walk: rules entries
// resolve, constructed project files do not).
const spelling = {
  root: join(proj, 'MERCURY.md'),
  real: join(rulesDir, 'real.md'),
  secret: join(rulesDir, 'secret-skip.md'),
  linkedFileTarget: join(targets, 'actual-rule.md'),
  packedTarget: join(targets, 'rule-pack', 'packed.md'),
}

// ── the hermetic child: scratch home, scratch cwd, per-leg settings ────────
const driverSrc = `
import { enableConfigs } from '${repo}/src/utils/config/globalConfig.js'
enableConfigs()
const { getInstructionFiles } = await import('${repo}/src/services/instructions/engine.js')
const { mercuryNativeConvention } = await import('${repo}/src/services/instructions/adapters/mercuryNative.js')
const files = await getInstructionFiles()
const probes = JSON.parse(process.env.EXCL_PROBES ?? '[]')
console.log(JSON.stringify({
  paths: files.map(f => f.path),
  probes: probes.map(([p, t]) => mercuryNativeConvention.isExcluded(p, t)),
}))
`
const driverDir = mkdtempSync(join(tmpdir(), 'excl-prove-drv-'))
const driverPath = join(driverDir, 'drv.ts')
writeFileSync(driverPath, driverSrc)

function drive(
  settings: Record<string, unknown>,
  probes: [string, string][] = [],
): { paths: string[]; probes: boolean[] } {
  const home = mkdtempSync(join(tmpdir(), 'excl-prove-home-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MERCURY_|HERMES_|TF_|CLAUDE_)/.test(k)) continue
    env[k] = v
  }
  env.MERCURY_CONFIG_DIR = home
  env.MERCURY_EVOLUTION_LEDGER = '0'
  env.EXCL_PROBES = JSON.stringify(probes)
  const run = spawnSync(process.execPath, ['run', driverPath], {
    cwd: proj,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  rmSync(home, { recursive: true, force: true })
  if (run.status !== 0) {
    console.error(`  [FAIL] driver exited ${run.status}: ${String(run.stderr).slice(0, 800)}`)
    process.exit(1)
  }
  const lines = String(run.stdout).trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!) as {
    paths: string[]
    probes: boolean[]
  }
}

console.log('instruction excludes — the setting, the symlink law, the immunities')

// ── negative: no pattern ⇒ every source composes, symlinked ones included ──
{
  const r = drive({})
  check(r.paths.includes(spelling.root), 'no pattern: the symlinked root file composes (symlink spelling)')
  check(r.paths.includes(spelling.real), 'no pattern: the plain rule composes')
  check(r.paths.includes(spelling.linkedFileTarget), 'no pattern: the symlinked rules file composes (target spelling)')
  check(r.paths.includes(spelling.packedTarget), 'no pattern: the symlink-dir rule composes (target spelling)')
}

// ── (a) pattern names the SYMLINK spelling of a rules file ─────────────────
// The engine walks the file under its target spelling; the pattern's
// glob-free whole-path resolution must reach it. Managed-immunity probes
// ride this leg: the same target path, three memory types.
{
  const r = drive(
    { instructionExcludes: [join(rulesDir, 'linked-file.md')] },
    [
      [spelling.linkedFileTarget, 'Managed'],
      [spelling.linkedFileTarget, 'User'],
      [spelling.linkedFileTarget, 'Project'],
    ],
  )
  check(!r.paths.includes(spelling.linkedFileTarget), '(a) symlink-spelling pattern excludes the file walked under its target spelling')
  check(r.paths.includes(spelling.real), '(a) the plain rule still composes')
  check(r.probes[0] === false, 'managed immunity: the matching pattern never excludes type Managed')
  check(r.probes[1] === true && r.probes[2] === true, 'the same path IS excluded for User and Project (the gate is the type, not the path)')
}

// ── (b) pattern names the TARGET of a symlinked root file ──────────────────
// The engine tests the constructed symlink spelling; the tested path's
// realpath twin must match.
{
  const r = drive({ instructionExcludes: [join(targets, 'ROOT-GUIDE.md')] })
  check(!r.paths.includes(spelling.root), '(b) target-spelling pattern excludes the root file tested under its symlink spelling')
  check(r.paths.includes(spelling.real), '(b) the plain rule still composes')
}

// ── (c) glob under the symlinked DIRECTORY spelling ────────────────────────
{
  const r = drive({ instructionExcludes: [join(rulesDir, 'linked-dir') + '/**'] })
  check(!r.paths.includes(spelling.packedTarget), '(c) symlink-dir glob excludes files walked under the target directory')
  check(r.paths.includes(spelling.real), '(c) the plain rule still composes')
  check(r.paths.includes(spelling.linkedFileTarget), '(c) the sibling symlinked file is untouched')
}

// ── (d) a pure glob ─────────────────────────────────────────────────────────
{
  const r = drive({ instructionExcludes: ['**/secret-*.md'] })
  check(!r.paths.includes(spelling.secret), '(d) a pure glob excludes without touching the filesystem')
  check(r.paths.includes(spelling.real), '(d) the plain rule still composes')
}

// ── the retired spelling excludes NOTHING ───────────────────────────────────
{
  const r = drive({ claudeMdExcludes: [join(rulesDir, 'linked-file.md'), '**/*.md'] })
  check(r.paths.includes(spelling.linkedFileTarget) && r.paths.includes(spelling.real), 'the retired claudeMdExcludes key is dead: nothing is excluded')
  check(r.paths.includes(spelling.root), 'a settings file carrying only the retired key still parses (composition ran)')
}

// ── in-process mechanism pins: schema shape + the tilde law ────────────────
{
  const { SettingsSchema } = await import(join(repo, 'src/utils/settings/types.ts'))
  const good = SettingsSchema().safeParse({ instructionExcludes: ['**/x.md'] })
  check(good.success === true && Array.isArray((good as { data?: Record<string, unknown> }).data?.instructionExcludes), 'schema: instructionExcludes is a typed key')
  const old = SettingsSchema().safeParse({ claudeMdExcludes: ['**/x.md'] })
  check(old.success === true && (old as { data?: Record<string, unknown> }).data?.instructionExcludes === undefined, 'schema: the retired spelling neither fails the parse nor aliases')

  const { matchesInstructionExcludes } = await import(join(repo, 'src/services/instructions/discovery.ts'))
  const home = homedir()
  check(matchesInstructionExcludes(join(home, '.tilde-probe', 'RULES.md'), ['~/.tilde-probe/RULES.md']) === true, 'tilde: a leading ~ means the operator home')
  check(matchesInstructionExcludes(join(home, '.tilde-probe', 'RULES.md'), ['~/.other/RULES.md']) === false, 'tilde: a non-matching ~ pattern stays a miss')
}

rmSync(root, { recursive: true, force: true })
rmSync(driverDir, { recursive: true, force: true })
console.log(failures === 0 ? '✅ instruction-exclusion law holds' : `❌ ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
