#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SEAL = 'scripts/gate/prove-vocabulary-seal.ts'
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const spell = (...parts: string[]): string => parts.join('')

section('§1 the hosted gate seals the vocabulary in its build job, after the build and before any shard')
{
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'gate.yml'), 'utf8')
  const buildAt = workflow.indexOf('\n  build:')
  const shardAt = workflow.indexOf('\n  shard:')
  const buildJob = buildAt >= 0 && shardAt > buildAt ? workflow.slice(buildAt, shardAt) : ''
  const stepAt = buildJob.indexOf(SEAL)
  const builtAt = buildJob.indexOf('bun run build.ts')
  const packAt = buildJob.indexOf('tar -czf dist.tar.gz')
  check('the build job runs the seal', stepAt >= 0, 'no step names scripts/gate/prove-vocabulary-seal.ts inside the build job')
  check('…after the dist is built (the bundle rule reads the fresh dist) and before the artifact is packed for the shards', stepAt > builtAt && builtAt >= 0 && packAt > stepAt, `build=${builtAt} seal=${stepAt} pack=${packAt}; move the seal step in the build job of .github/workflows/gate.yml to sit after bun run build.ts and before tar -czf dist.tar.gz`)
  check('…as a plain run step with the canonical bun (a red step fails the build job, and every shard needs build)', /run:\s*~\/\.bun\/bin\/bun scripts\/gate\/prove-vocabulary-seal\.ts\s*\n/.test(buildJob) && /\n  shard:[\s\S]*?needs: build/.test(workflow), 'in .github/workflows/gate.yml the seal step must read run: ~/.bun/bin/bun scripts/gate/prove-vocabulary-seal.ts alone on its line in the build job, and the shard job must keep needs: build')
  const runner = readFileSync(join(ROOT, 'scripts', 'gate', 'members.txt'), 'utf8')
  check('the gate suite enrols the seal and this proof (the local pool and the release chain read the same file)', runner.includes('prove-vocabulary-seal.ts') && runner.includes('prove-seal-in-gate.ts'), 'add the missing script name, prove-vocabulary-seal.ts or prove-seal-in-gate.ts, as a line of scripts/gate/members.txt')
  check('the seal lives in the product tree as the one owner of its rules', existsSync(join(ROOT, SEAL)), `${SEAL} is absent: restore it, the seal must live at that path`)
}

section('§2 the seal over a fixture tree: a retired word is red with its rule and line; a clean tree is green')
{
  const seal = existsSync(join(ROOT, SEAL)) ? await import('./prove-vocabulary-seal.ts') : null
  if (seal === null) check('the seal module imports', false, `${SEAL} is absent`)
  else {
    const fixture = mkdtempSync(join(tmpdir(), 'seal-fixture-'))
    const put = (rel: string, content: string): void => {
      mkdirSync(dirname(join(fixture, rel)), { recursive: true })
      writeFileSync(join(fixture, rel), content)
    }
    execFileSync('git', ['init', '-q', fixture])
    put('src/clean.ts', "export const word = 'extension'\n")
    put('docs/clean.md', 'An extension comes from a source; add one with /extensions.\n')
    put('README.md', '# fixture\nmercury run --format rows\n')
    execFileSync('git', ['-C', fixture, 'add', 'src/clean.ts', 'docs/clean.md', 'README.md'])
    const clean = seal.sealTree(fixture)
    check('a clean fixture tree is green (three tracked files, no violation)', clean.tracked.length === 3 && clean.violations.length === 0, `${clean.violations.map(v => `${v.path}:${v.line} [${v.rule}]`).join(' · ')}; sealTree in ${SEAL} must read only tracked files and flag none of the clean fixture words`)
    put('src/old.ts', `const legend = 'press ${spell('Strat', 'egy Mode')} to plan'\n`)
    put('docs/old.md', `Run \`mercury ${spell('--pr', 'int')} hello\` for one answer.\n`)
    put('src/untracked.ts', `const t = '${spell('ultra', 'think')}'\n`)
    execFileSync('git', ['-C', fixture, 'add', 'src/old.ts', 'docs/old.md'])
    const red = seal.sealTree(fixture)
    const rules = red.violations.map(v => `${v.path}:${v.line} [${v.rule}]`)
    check('a retired word in src is red, named with its rule and line', rules.includes('src/old.ts:1 [retired:strategy-band]'), `${rules.join(' · ')}; the retired:strategy-band rule in ${SEAL} must flag the planted src line`)
    check('a retired run word in docs is red, named with its rule and line', rules.includes('docs/old.md:1 [words:run-print]'), `${rules.join(' · ')}; the words:run-print rule in ${SEAL} must flag the planted docs line`)
    check('an untracked file is not read (the seal reads the tracked tree, as the gate checks it out)', !rules.some(r => r.startsWith('src/untracked.ts')), `${rules.join(' · ')}; sealTree in ${SEAL} must list files through git, tracked only`)
    check('exactly the two planted lines are red', red.violations.length === 2, `${rules.join(' · ')}; a rule in ${SEAL} flags a line it should not, or misses a planted one`)
    const moot = seal.mootRows([['src/clean.ts', 'words', 'a row for a file the fixture holds'], ['src/gone.ts', 'words', 'a row for a file the fixture lost']], red.tracked)
    check('an allow row for a path the tree no longer holds is reported', moot.length === 1 && moot[0] === 'src/gone.ts', `${moot.join(' · ')}; mootRows in ${SEAL} must return the allow rows whose path is not in the tracked list`)
    const unreasoned = seal.unreasonedRows([['src/clean.ts', 'words', 'a row with its reason spelled out'], ['src/clean.ts', 'retired', ''], ['src/clean.ts', 'settings', 'tbd']])
    check('an allow row with no reason (or a token in place of one) is reported', unreasoned.length === 2 && unreasoned[0] === 'src/clean.ts (retired)' && unreasoned[1] === 'src/clean.ts (settings)', `${unreasoned.join(' · ')}; unreasonedRows in ${SEAL} must report a row whose reason is empty or a bare token`)
    rmSync(fixture, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`\nprove-seal-in-gate: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-seal-in-gate: all green')
