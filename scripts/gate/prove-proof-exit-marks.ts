#!/usr/bin/env bun
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'proof-exits-'))
const stub = join(scratch, 'bun')
writeFileSync(stub, '#!/bin/sh\nprintf "FAIL  diagnostic wording is not the result\\n"\nexit "$PROOF_FIXTURE_RC"\n')
chmodSync(stub, 0o755)
const env = (code: number) => ({ PATH: `${scratch}:${process.env.PATH}`, HOME: scratch, BUN: stub, MERCURY_CONFIG_DIR: scratch, PROOF_FIXTURE_RC: String(code) })
let checks = 0
const check = (label: string, ok: unknown): void => { assert(ok, label); checks++; console.log(`PASS ${label}`) }
const marks = (text: string) => [...text.matchAll(/^── (.+?)\s+(\d+)s rc=(\d+)$/gm)].map(match => ({ path: match[1]!, code: Number(match[3]) }))
const globToRegExp = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}
const loopWords = (list: string, present: readonly string[]): number =>
  list.split(/\s+/).filter(word => word !== '').map(word => {
    const name = word.replace(/"/g, '').split('/').pop() ?? ''
    return name.includes('*') || name.includes('?') ? present.filter(file => globToRegExp(name).test(file)).length : 1
  }).reduce((sum, n) => sum + n, 0)
const promisedMarks = (runner: string, present: readonly string[]): number => {
  let promised = 0
  const loops: number[] = []
  for (const line of runner.split('\n')) {
    const loop = /^\s*for\s+\w+\s+in\s+(.+?)\s*(?:;\s*do)?\s*$/.exec(line)
    if (loop) {
      loops.push(loopWords(loop[1]!, present))
      continue
    }
    if (/^\s*done\b/.test(line)) {
      loops.pop()
      continue
    }
    const calls = (line.includes('__t=$SECONDS') ? 1 : 0) + (/^\s*run_proof\s/.test(line) ? 1 : 0)
    promised += calls * loops.reduce((product, n) => product * n, 1)
  }
  return promised
}
try {
  const suites = readdirSync(join(root, 'scripts'), { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const path = join(root, 'scripts', entry.name, 'run-all.sh')
    try { return [{ path, text: readFileSync(path, 'utf8') }] } catch { return [] }
  })
  for (const suite of suites) {
    const syntax = spawnSync('bash', ['-n', suite.path], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, `${suite.path}: ${syntax.stderr}`)
    if (suite.text.includes('prover_mark()')) {
      assert(suite.text.includes('rc=%s'), `${suite.path}: missing exit field`)
      for (const line of suite.text.split('\n')) {
        if (!line.includes('prover_mark ') || line.includes('prover_mark()')) continue
        assert(/"\$[^"\s]+"\s+"\$__rc"/.test(line), `${suite.path}: mark does not receive the captured code`)
      }
    } else if (/^\s*(?:"\$[bB][uU][nN]"|"\$\{BUN).*\b(?:run\s+)?[^\n]*prove-/m.test(suite.text)) {
      assert(suite.text.includes('run_proof '), `${suite.path}: named proofs have no result marks`)
    }
  }
  check('every suite parses and every existing timed mark receives an explicit exit code', suites.length > 100)
  for (const name of ['daemon', 'engine-connector', 'model-registry', 'navigation', 'wallet', 'distribution', 'winreg', 'default-provider', 'usage-warning', 'idiom']) {
    for (const code of [0, 7]) {
      const result = spawnSync('bash', [join(root, 'scripts', name, 'run-all.sh')], { cwd: root, env: env(code), encoding: 'utf8', timeout: 10000 })
      const rows = marks(result.stdout)
      check(`${name}: code ${code} is preserved in every mark`, rows.length > 0 && rows.every(row => row.code === code))
      check(`${name}: aggregate result is unchanged for code ${code}`, result.status === (code === 0 ? 0 : 1))
    }
  }
  const channels = spawnSync('bash', [join(root, 'scripts/channels/run-all.sh')], { cwd: root, env: env(23), encoding: 'utf8', timeout: 10000 })
  check('a failed first command in a chained condition keeps its original code', marks(channels.stdout).length === 3 && marks(channels.stdout).every(row => row.code === 23))
  const estate = join(scratch, 'estate')
  mkdirSync(join(estate, 'scripts/lib'), { recursive: true })
  mkdirSync(join(estate, 'dist'))
  writeFileSync(join(estate, 'dist/mercury.mjs'), '')
  for (const file of ['suite-env.sh', 'proof-runner.sh']) writeFileSync(join(estate, 'scripts/lib', file), readFileSync(join(root, 'scripts/lib', file)))
  const fixture = '#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in */journey-j[1-5].ts) n="${arg##*/journey-j}"; n="${n%.ts}"; printf "{}\\n" > "$TMPDIR/momentum-report-J$n.json";; esac\ndone\nprintf "FAIL  diagnostic wording is not the result\\n"\nexit "$PROOF_FIXTURE_RC"\n'
  const nodeStub = join(scratch, 'node')
  writeFileSync(nodeStub, fixture)
  chmodSync(nodeStub, 0o755)
  writeFileSync(stub, fixture)
  const copiedRunners = new Map<string, string>()
  console.log('each counted suite\'s expected mark count is read from its runner: one mark per timed command (__t=$SECONDS) or run_proof line, a for loop multiplied by its words with a glob matched against the census\'s own fixture files; every guard in a runner passes in this estate by construction (a dist file, the fixture files, the close-arc switch)')
  for (const [name, files] of [
    ['smoke', []],
    ['api', []],
    ['attention', ['prove-fixture.ts', 'journey-fixture.ts']],
    ['session-graph', ['run-journeys.ts', 'run-sensitivity.ts']],
    ['golden-journeys', []],
    ['node-runtime', ['qualify-artifact.sh']],
    ['splash', []],
    ['vulcan', ['prove-fixture.ts', 'prove-addon-compiles.sh']],
    ['blender-bridge', ['prove-fixture.ts', 'regen-bridge.mjs']],
    ['unity-bridge', ['prove-fixture.ts', 'regen-bridge.mjs']],
    ['project-services', ['prove-fixture.ts']],
  ] as const) {
    const dir = join(estate, 'scripts', name)
    mkdirSync(dir)
    const runner = join(dir, 'run-all.sh')
    copiedRunners.set(name, runner)
    const text = readFileSync(join(root, 'scripts', name, 'run-all.sh'), 'utf8')
    writeFileSync(runner, text)
    for (const file of files) writeFileSync(join(dir, file), fixture)
    const count = promisedMarks(text, ['run-all.sh', ...files])
    check(`${name}: the runner promises at least one mark (${count} read from its own lines)`, count > 0)
    for (const code of [0, 29]) {
      const result = spawnSync('bash', [runner], { cwd: estate, env: { ...env(code), TMPDIR: scratch, CONSTELLATION_CLOSE_ARC: '1' }, encoding: 'utf8', timeout: 10000 })
      const rows = marks(result.stdout)
      check(`${name}: every individual command records code ${code} (${rows.length} of ${count} marks the runner promises)`, rows.length === count && rows.every(row => row.code === code))
      check(`${name}: individual checks retain the suite result for code ${code}`, result.status === (code === 0 ? 0 : 1))
    }
  }
  const apiRunner = readFileSync(join(root, 'scripts/api/run-all.sh'), 'utf8')
  const apiLines = apiRunner.split('\n')
  const lastCall = apiLines.findLastIndex(line => line.includes('__t=$SECONDS'))
  const markCall = /prover_mark\s.*$/.exec(apiLines[lastCall] ?? '')?.[0] ?? ''
  const apiCount = promisedMarks(apiRunner, ['run-all.sh'])
  const variant = (name: string, replaceLast: (line: string) => string[]): { promised: number; rows: ReturnType<typeof marks> } => {
    const dir = join(estate, 'scripts', name)
    mkdirSync(dir)
    const text = [...apiLines.slice(0, lastCall), ...replaceLast(apiLines[lastCall] ?? ''), ...apiLines.slice(lastCall + 1)].join('\n')
    writeFileSync(join(dir, 'run-all.sh'), text)
    const result = spawnSync('bash', [join(dir, 'run-all.sh')], { cwd: estate, env: env(0), encoding: 'utf8', timeout: 10000 })
    return { promised: promisedMarks(text, ['run-all.sh']), rows: marks(result.stdout) }
  }
  const enrolled = variant('api-enrolled', line => [line, line.replace(/prove-[a-z0-9-]+\.ts/g, 'prove-enrolled-later.ts')])
  check(`enrolling a proof in a runner moves the runner's own count (${apiCount} → ${apiCount + 1}); the census stays green with no table to edit`, lastCall >= 0 && enrolled.promised === apiCount + 1 && enrolled.rows.length === enrolled.promised && enrolled.rows.every(row => row.code === 0))
  const unmarked = variant('api-unmarked', line => [line.replace(/;\s*prover_mark\s.*$/, '')])
  check('a timed command that prints no mark is a disagreement the census sees: the marks fall short of the count the runner promises', unmarked.promised === apiCount && unmarked.rows.length === apiCount - 1)
  const doubled = variant('api-doubled', line => [`${line}; ${markCall}`])
  check('a mark that prints twice is a disagreement the census sees: the marks exceed the count the runner promises', markCall !== '' && doubled.promised === apiCount && doubled.rows.length === apiCount + 1)
  const refusedApi = spawnSync('bash', [copiedRunners.get('api')!], { cwd: estate, env: { ...env(0), MERCURY_MODEL: 'foreign-fixture' }, encoding: 'utf8', timeout: 10000 })
  check('the API runner refuses foreign environment before any command executes', refusedApi.status === 78 && marks(refusedApi.stdout).length === 0 && !refusedApi.stdout.includes('diagnostic wording'))
  const attentionRed = spawnSync('bash', [copiedRunners.get('attention')!], { cwd: estate, env: { ...env(3), TMPDIR: scratch }, encoding: 'utf8', timeout: 10000 })
  check('a machine-gated journey that exits non-zero is red with its actual code in the mark and no skip wording', attentionRed.status === 1 && marks(attentionRed.stdout).some(row => row.path.endsWith('/journey-fixture.ts') && row.code === 3) && attentionRed.stdout.includes('journey-fixture.ts exited 3') && !/SKIP/.test(attentionRed.stdout))
  writeFileSync(stub, '#!/bin/sh\ncase "$*" in *journey-*) printf "  [SKIP] journey-fixture: this machine lacks the install the journey drives\\n"; exit 0;; esac\nprintf "FAIL  diagnostic wording is not the result\\n"\nexit "$PROOF_FIXTURE_RC"\n')
  const attentionSkip = spawnSync('bash', [copiedRunners.get('attention')!], { cwd: estate, env: { ...env(0), TMPDIR: scratch }, encoding: 'utf8', timeout: 10000 })
  check('a machine-gated journey skips by a [SKIP] line on a green mark: rc=0 recorded, the suite green, the line in the suite output', attentionSkip.status === 0 && marks(attentionSkip.stdout).some(row => row.path.endsWith('/journey-fixture.ts') && row.code === 0) && /\[SKIP\] journey-fixture/.test(attentionSkip.stdout))
  writeFileSync(stub, fixture)
  const nestedDir = join(estate, 'scripts/nested/sub')
  mkdirSync(nestedDir, { recursive: true })
  const nestedRunner = join(nestedDir, 'run-all.sh')
  writeFileSync(nestedRunner, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '. "$(dirname "$0")/../../lib/proof-runner.sh"',
    'cd "$(dirname "$0")/../../.."',
    'BUN="${BUN:-$HOME/.bun/bin/bun}"',
    'fail=0',
    'run_proof scripts/nested/sub/prove-one.ts "$BUN" run scripts/nested/sub/prove-one.ts || fail=1',
    'run_proof scripts/nested/sub/prove-two.ts "$BUN" run scripts/nested/sub/prove-two.ts || fail=1',
    'run_proof scripts/nested/sub/prove-three.ts "$BUN" run scripts/nested/sub/prove-three.ts || fail=1',
    'if [[ "${UI_RENDER:-}" == "1" ]]; then',
    '  run_proof scripts/nested/sub/render-one.tsx "$BUN" run scripts/nested/sub/render-one.tsx || fail=1',
    'fi',
    'exit "$fail"',
    '',
  ].join('\n'))
  const nested = spawnSync('bash', [nestedRunner], { cwd: estate, env: { ...env(7), UI_RENDER: '1' }, encoding: 'utf8', timeout: 10000 })
  check('a nested runner names its render leg and records its result', nested.status === 1 && marks(nested.stdout).length === 4 && marks(nested.stdout).some(row => row.path === 'scripts/nested/sub/render-one.tsx' && row.code === 7))
  const helper = join(root, 'scripts/lib/proof-runner.sh')
  for (const code of [0, 3, 19, 143]) {
    const result = spawnSync('bash', ['-c', '. "$1"; run_proof "scripts/example/prove-silent.ts" bash -c "exit $2"', 'test', helper, String(code)], { encoding: 'utf8' })
    check(`the shared runner returns and records ${code}`, result.status === code && marks(result.stdout)[0]?.code === code)
  }
  const timeline = spawnSync('python3', ['-c', 'import runpy,sys; m=runpy.run_path(sys.argv[1])["PROVER_LINE"]; assert m.fullmatch("── scripts/example/prove-one.ts  2s rc=7").group(3)=="7"; assert m.fullmatch("── scripts/example/prove-one.ts  2s").group(3) is None', join(root, 'scripts/gate/timeline.py')], { encoding: 'utf8' })
  check('timeline reads current and historical marks without fabricating a legacy exit', timeline.status === 0)
  console.log(`Proof exit marks: ${checks} checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
