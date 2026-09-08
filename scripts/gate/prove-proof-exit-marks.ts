#!/usr/bin/env bun
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'proof-exits-'))
const stub = join(scratch, 'bun')
writeFileSync(stub, '#!/bin/sh\nprintf "FAIL  diagnostic wording is not the result\\n"\nexit "$PROOF_FIXTURE_RC"\n')
chmodSync(stub, 0o755)
const env = (code: number) => ({ PATH: `${scratch}:${process.env.PATH}`, HOME: scratch, BUN: stub, MERCURY_CONFIG_DIR: scratch, PROOF_FIXTURE_RC: String(code) })
let checks = 0
const check = (label: string, ok: unknown): void => { assert(ok, label); checks++; console.log(`PASS ${label}`) }
const marks = (text: string) => [...text.matchAll(/^── (.+?)\s+(\d+)s rc=(\d+)$/gm)].map(match => ({ path: match[1]!, code: Number(match[3]) }))
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
