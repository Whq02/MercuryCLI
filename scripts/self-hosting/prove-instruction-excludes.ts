#!/usr/bin/env bun
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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'excl-prove-')))
const proj = join(root, 'proj')
const rulesDir = join(proj, '.mercury', 'rules')
const targets = join(proj, 'targets')
mkdirSync(rulesDir, { recursive: true })
mkdirSync(join(targets, 'rule-pack'), { recursive: true })

writeFileSync(join(targets, 'ROOT-GUIDE.md'), 'root guide body\n')
symlinkSync(join(targets, 'ROOT-GUIDE.md'), join(proj, 'MERCURY.md'))

writeFileSync(join(rulesDir, 'real.md'), 'plain rule\n')
writeFileSync(join(rulesDir, 'secret-skip.md'), 'glob-bait rule\n')
writeFileSync(join(targets, 'actual-rule.md'), 'linked rule body\n')
symlinkSync(join(targets, 'actual-rule.md'), join(rulesDir, 'linked-file.md'))
writeFileSync(join(targets, 'rule-pack', 'packed.md'), 'packed rule body\n')
symlinkSync(join(targets, 'rule-pack'), join(rulesDir, 'linked-dir'))

const spelling = {
  root: join(proj, 'MERCURY.md'),
  real: join(rulesDir, 'real.md'),
  secret: join(rulesDir, 'secret-skip.md'),
  linkedFileTarget: join(targets, 'actual-rule.md'),
  packedTarget: join(targets, 'rule-pack', 'packed.md'),
}

const driverSrc = `
import { enableConfigs } from '${repo}/src/utils/config/globalConfig.js'
enableConfigs()
const { getInstructionFiles } = await import('${repo}/src/services/instructions/engine.js')
const { mercuryNativeConvention } = await import('${repo}/src/services/instructions/adapters/mercuryNative.js')
const { getSettingsWithErrors } = await import('${repo}/src/utils/settings/settings.js')
const files = await getInstructionFiles()
const probes = JSON.parse(process.env.EXCL_PROBES ?? '[]')
console.log(JSON.stringify({
  paths: files.map(f => f.path),
  probes: probes.map(([p, t]) => mercuryNativeConvention.isExcluded(p, t)),
  warnings: getSettingsWithErrors().errors.map(e => ({ path: String(e.path), message: e.message })),
}))
`
const driverDir = mkdtempSync(join(tmpdir(), 'excl-prove-drv-'))
const driverPath = join(driverDir, 'drv.ts')
writeFileSync(driverPath, driverSrc)

function drive(
  settings: Record<string, unknown>,
  probes: [string, string][] = [],
): { paths: string[]; probes: boolean[]; warnings: Array<{ path: string; message: string }> } {
  const home = mkdtempSync(join(tmpdir(), 'excl-prove-home-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MERCURY_|CLAUDE_)/.test(k)) continue
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
    warnings: Array<{ path: string; message: string }>
  }
}

console.log('instruction excludes — the setting, the symlink law, the immunities')

{
  const r = drive({})
  check(r.paths.includes(spelling.root), 'no pattern: the symlinked root file composes (symlink spelling)')
  check(r.paths.includes(spelling.real), 'no pattern: the plain rule composes')
  check(r.paths.includes(spelling.linkedFileTarget), 'no pattern: the symlinked rules file composes (target spelling)')
  check(r.paths.includes(spelling.packedTarget), 'no pattern: the symlink-dir rule composes (target spelling)')
}

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

{
  const r = drive({ instructionExcludes: [join(targets, 'ROOT-GUIDE.md')] })
  check(!r.paths.includes(spelling.root), '(b) target-spelling pattern excludes the root file tested under its symlink spelling')
  check(r.paths.includes(spelling.real), '(b) the plain rule still composes')
}

{
  const r = drive({ instructionExcludes: [join(rulesDir, 'linked-dir') + '/**'] })
  check(!r.paths.includes(spelling.packedTarget), '(c) symlink-dir glob excludes files walked under the target directory')
  check(r.paths.includes(spelling.real), '(c) the plain rule still composes')
  check(r.paths.includes(spelling.linkedFileTarget), '(c) the sibling symlinked file is untouched')
}

{
  const r = drive({ instructionExcludes: ['**/secret-*.md'] })
  check(!r.paths.includes(spelling.secret), '(d) a pure glob excludes without touching the filesystem')
  check(r.paths.includes(spelling.real), '(d) the plain rule still composes')
}

{
  const r = drive({ claudeMdExcludes: [join(rulesDir, 'linked-file.md')] })
  check(!r.paths.includes(spelling.linkedFileTarget), 'the claudeMdExcludes alias key is ACCEPTED: its pattern excludes exactly as instructionExcludes would')
  check(r.paths.includes(spelling.real) && r.paths.includes(spelling.root), 'a settings file carrying only the alias key still parses (composition ran; the unmatched rules compose)')
  const aliasWarning = r.warnings.find(w => w.path.includes('claudeMdExcludes'))
  check(aliasWarning !== undefined && aliasWarning.message.includes('instructionExcludes'), 'the acceptance is NAMED as a settings warning that names instructionExcludes (never silent)')
  const both = drive({ claudeMdExcludes: ['**/*.md'], instructionExcludes: [join(rulesDir, 'secret-skip.md')] })
  check(!both.paths.includes(spelling.secret) && both.paths.includes(spelling.real) && both.paths.includes(spelling.root), 'when both keys are present instructionExcludes wins (the alias value never overrides it)')
  check(!drive({ instructionExcludes: [join(rulesDir, 'secret-skip.md')] }).warnings.some(w => w.path.includes('claudeMdExcludes')), 'instructionExcludes alone raises no alias warning')
}

{
  const { SettingsSchema } = await import(join(repo, 'src/utils/settings/types.ts'))
  const good = SettingsSchema().safeParse({ instructionExcludes: ['**/x.md'] })
  check(good.success === true && Array.isArray((good as { data?: Record<string, unknown> }).data?.instructionExcludes), 'schema: instructionExcludes is a typed key')
  const old = SettingsSchema().safeParse({ claudeMdExcludes: ['**/x.md'] })
  check(old.success === true && (old as { data?: Record<string, unknown> }).data?.instructionExcludes === undefined, 'schema: the alias key neither fails the parse nor lands as instructionExcludes')

  const { matchesInstructionExcludes } = await import(join(repo, 'src/services/instructions/discovery.ts'))
  const home = homedir()
  check(matchesInstructionExcludes(join(home, '.tilde-probe', 'RULES.md'), ['~/.tilde-probe/RULES.md']) === true, 'tilde: a leading ~ means the operator home')
  check(matchesInstructionExcludes(join(home, '.tilde-probe', 'RULES.md'), ['~/.other/RULES.md']) === false, 'tilde: a non-matching ~ pattern stays a miss')
}

rmSync(root, { recursive: true, force: true })
rmSync(driverDir, { recursive: true, force: true })
console.log(failures === 0 ? '✅ instruction-exclusion law holds' : `❌ ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
