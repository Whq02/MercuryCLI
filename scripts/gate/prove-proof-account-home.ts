#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'proof-account-law-'))
try {
  const invokingHome = join(scratch, 'invoking-home')
  const ownedTmp = join(scratch, 'owned-tmp')
  mkdirSync(invokingHome); mkdirSync(ownedTmp)
  writeFileSync(join(invokingHome, 'canary'), 'unchanged')
  const before = readdirSync(invokingHome)
  const script = join(scratch, 'child.ts')
  writeFileSync(script, `import { withProofAccountHome } from ${JSON.stringify(join(ROOT, 'scripts/lib/proofAccountHome.ts'))}
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = withProofAccountHome()
if (homedir() !== home) throw new Error('runtime cached a different home')
writeFileSync(join(home, 'fixture-write'), 'only in the child home')
console.log(JSON.stringify({home}))
process.exit(7)
`)
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, HOME: invokingHome, USERPROFILE: invokingHome, TMPDIR: ownedTmp } })
  assert.equal(result.status, 7, result.stderr)
  const { home } = JSON.parse(result.stdout.trim()) as { home: string }
  assert.ok(home.startsWith(realpathSync(ownedTmp) + '/') && home !== realpathSync(invokingHome))
  assert.equal(existsSync(home), false, 'the parent removes the synthetic account after failure too')
  assert.deepEqual(readdirSync(invokingHome), before)
  assert.equal(readFileSync(join(invokingHome, 'canary'), 'utf8'), 'unchanged')
  assert.deepEqual(readdirSync(ownedTmp), [])
  for (const file of ['scripts/realms/prove-realm-registry.ts', 'scripts/wards/prove-delete-ward-resolves-path.ts', 'scripts/gate/prove-run-root-socket-bound.ts']) {
    const refAt = process.argv.indexOf('--ref')
    const ref = refAt < 0 ? undefined : process.argv[refAt + 1]
    const text = ref ? execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8' }) : readFileSync(join(ROOT, file), 'utf8')
    assert.ok(text.includes('withProofAccountHome('), `${file} must establish its account home before runtime reads`)
    assert.ok(!/mkdtempSync\(join\(homedir\(\)/.test(text), `${file} may not allocate under the invoking account`)
  }
  console.log('PASS account-home proofs re-exec with a synthetic home, preserve the child exit and remove only their scratch world; invoking home unchanged')
} finally { rmSync(scratch, { recursive: true, force: true }) }
