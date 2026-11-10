#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const BUILT_TREE = '1'.repeat(40)
const WORKING_TREE = '2'.repeat(40)
const BUNDLE_FLAG = ['--', 'dist'].join('')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

if (process.platform === 'win32') {
  console.log('  [SKIP] the stand-in git of this proof is a POSIX shell script')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'stale-dist-guard-'))
const dist = join(scratch, 'dist')
const bin = join(scratch, 'bin')
const gitLog = join(scratch, 'git.log')
mkdirSync(dist)
mkdirSync(bin)
writeFileSync(join(dist, 'mercury.mjs'), '')
writeFileSync(
  join(bin, 'git'),
  ['#!/bin/sh', `printf '%s\\n' "$1" >> ${JSON.stringify(gitLog)}`, 'case "$1" in', `  write-tree) printf '%s\\n' ${WORKING_TREE} ;;`, `  diff-tree) printf '%b' "$STALE_DIST_PROOF_DELTA" ;;`, 'esac', 'exit 0', ''].join('\n'),
)
chmodSync(join(bin, 'git'), 0o755)
const child = join(scratch, 'three-scenarios.ts')
writeFileSync(
  child,
  [
    `const { scenario } = await import(${JSON.stringify(join(ROOT, 'scripts', 'ui', 'renderScenarios.ts'))})`,
    'const verdicts: string[] = []',
    'for (let i = 0; i < 3; i++) {',
    '  try {',
    "    scenario('frame', 80, 24)",
    "    verdicts.push('rendered')",
    '  } catch (error) {',
    "    verdicts.push(error instanceof Error && error.message.startsWith('STALE DIST') ? `refused ${error.message}` : `threw ${String(error)}`)",
    '  }',
    '}',
    'console.log(`VERDICTS ${JSON.stringify(verdicts)}`)',
    '',
  ].join('\n'),
)

type Run = { verdicts: string[]; treeReads: number; raw: string }
function threeScenarios(name: string, buildTree: string | null, delta: string, extra: Record<string, string> = {}): Run {
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(buildTree === null ? {} : { buildTree }))
  rmSync(gitLog, { force: true })
  const home = join(scratch, `home-${name}`)
  mkdirSync(home)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, MERCURY_CONFIG_DIR: home, MERCURY_RENDER_CWD: scratch, STALE_DIST_PROOF_DELTA: delta, ...extra }
  for (const key of ['MERCURY_GATE_PREBUILT', 'MERCURY_STALE_DIST_OK']) if (!(key in extra)) delete env[key]
  const res = spawnSync(process.execPath, [child, BUNDLE_FLAG, join(dist, 'mercury.mjs')], { cwd: scratch, env, encoding: 'utf8', timeout: 120_000 })
  const raw = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const line = raw.split('\n').find(l => l.startsWith('VERDICTS '))
  const verdicts = line === undefined ? [] : (JSON.parse(line.slice('VERDICTS '.length)) as string[])
  const treeReads = existsSync(gitLog) ? readFileSync(gitLog, 'utf8').split('\n').filter(l => l === 'write-tree').length : 0
  return { verdicts, treeReads, raw }
}
const all = (run: Run, word: string): boolean => run.verdicts.length === 3 && run.verdicts.every(v => v === word || v.startsWith(`${word} `))

console.log('§1 a bundle built from another tree is refused for every scenario of the process, not only the first')
const stale = threeScenarios('stale', BUILT_TREE, 'src/utils/effort.ts\\ndocs/ENGINES.md\\n')
check('the first scenario is refused', stale.verdicts[0]?.startsWith('refused ') === true, stale.verdicts[0] ?? stale.raw.slice(-400))
check('the second and third scenarios are refused as well', all(stale, 'refused'), JSON.stringify(stale.verdicts.map(v => v.slice(0, 60))))
check('every refusal names the built tree, the working tree and the build-input delta alone', stale.verdicts.length === 3 && stale.verdicts.every(v => v.includes(BUILT_TREE.slice(0, 12)) && v.includes(WORKING_TREE.slice(0, 12)) && v.includes('(build-input delta: src/utils/effort.ts)')), stale.verdicts[2] ?? '')
check('the working tree is read once for the three scenarios', stale.treeReads === 1, `write-tree ran ${stale.treeReads} times`)

console.log('§2 what the guard accepted before it still accepts, for every scenario')
const safe = threeScenarios('safe', BUILT_TREE, 'docs/ENGINES.md\\nscripts/ui/renderScenarios.ts\\nREADME.md\\n')
check('a delta of docs, scripts and top-level pages renders all three', all(safe, 'rendered'), JSON.stringify(safe.verdicts.map(v => v.slice(0, 80))))
const ignores = threeScenarios('ignores', BUILT_TREE, '.gitignore\\nsrc/.gitignore\\n')
check('a delta of ignore files alone renders all three: the build reads none of them', all(ignores, 'rendered'), JSON.stringify(ignores.verdicts.map(v => v.slice(0, 120))))
const ignoresAndSource = threeScenarios('ignores-and-source', BUILT_TREE, '.gitignore\\nsrc/utils/effort.ts\\n')
check('an ignore file beside a source file is refused, and the source alone is named', all(ignoresAndSource, 'refused') && ignoresAndSource.verdicts.every(v => v.includes('(build-input delta: src/utils/effort.ts)')), ignoresAndSource.verdicts[0] ?? ignoresAndSource.raw.slice(-300))
const same = threeScenarios('same', WORKING_TREE, '')
check('a bundle built from the working tree renders all three', all(same, 'rendered'), JSON.stringify(same.verdicts.map(v => v.slice(0, 80))))
const undeclared = threeScenarios('undeclared', null, '')
check('a bundle that declares no tree renders all three and reads no tree', all(undeclared, 'rendered') && undeclared.treeReads === 0, `${JSON.stringify(undeclared.verdicts.map(v => v.slice(0, 80)))} · write-tree ran ${undeclared.treeReads} times`)

console.log('§3 the two declared overrides bind a historical bundle for every scenario')
const bound = threeScenarios('bound', BUILT_TREE, 'src/utils/effort.ts\\n', { MERCURY_STALE_DIST_OK: '1' })
check('MERCURY_STALE_DIST_OK=1 renders all three', all(bound, 'rendered'), JSON.stringify(bound.verdicts.map(v => v.slice(0, 80))))
const prebuilt = threeScenarios('prebuilt', BUILT_TREE, 'src/utils/effort.ts\\n', { MERCURY_GATE_PREBUILT: '1' })
check('MERCURY_GATE_PREBUILT=1 renders all three', all(prebuilt, 'rendered'), JSON.stringify(prebuilt.verdicts.map(v => v.slice(0, 80))))

rmSync(scratch, { recursive: true, force: true })
console.log(`\nstale-dist-guard: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
