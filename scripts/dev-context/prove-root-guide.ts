#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

section('(1) AGENTS.md — the one root guide, a screen long, complete')
{
  const path = join(ROOT, 'AGENTS.md')
  check('AGENTS.md exists', existsSync(path), '', 'restore AGENTS.md at the repository root; it is the one root guide')
  const guide = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = guide.split('\n').length
  check(`AGENTS.md stays a screen long (${lines} lines ≤ 80)`, lines <= 80, '', 'trim AGENTS.md at the repository root to 80 lines or fewer')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines?: { node?: string } }
  const range = pkg.engines?.node ?? ''
  check(`AGENTS.md states the supported Node range (${range})`, range !== '' && guide.includes(range), '', 'make the Node range in AGENTS.md (Prerequisites) match engines.node in package.json, and keep engines.node set')
}

section('(2) AGENTS.md stands alone at the root')
{
  check('no second guide file sits beside AGENTS.md', !existsSync(join(ROOT, 'CLAUDE.md')), '', 'delete CLAUDE.md at the repository root and keep the guidance in AGENTS.md')
}

section('(3) no tool-specific developer estate is tracked')
{
  const tracked = execFileSync('git', ['ls-files', '--', '.claude', '.mercury'], { cwd: ROOT, encoding: 'utf8' }).trim()
  check('nothing under .claude/ or .mercury/ is tracked', tracked === '', tracked.split('\n').slice(0, 3).join(', '), 'untrack these paths with git rm --cached and add .claude/ and .mercury/ to .gitignore')
}

section('(4) the commit-msg hook: a message passes as written, the attribution trailer is spelled exactly')
{
  const HOOK = join(ROOT, 'scripts', 'git-hooks', 'commit-msg')
  const hookDir = mkdtempSync(join(tmpdir(), 'commit-hook-'))
  let n = 0
  const runHook = (msg: string): { status: number; after: string } => {
    const file = join(hookDir, `msg-${n++}.txt`)
    writeFileSync(file, msg)
    const res = spawnSync('bash', [HOOK, file], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })
    return { status: res.status ?? 1, after: readFileSync(file, 'utf8') }
  }
  const clean = 'Add a change.\n'
  const a = runHook(clean)
  check('a message passes byte-unchanged', a.status === 0 && a.after === clean, '', 'scripts/git-hooks/commit-msg must exit 0 and leave a message without a Mercury trailer unchanged')
  const other = clean + '\nCo-Authored-By: A Person <person@example.invalid>\n'
  const b = runHook(other)
  check('another co-author passes byte-unchanged', b.status === 0 && b.after === other, '', 'scripts/git-hooks/commit-msg must exit 0 and leave a non-Mercury Co-Authored-By trailer unchanged')
  const attribution = clean + '\nCo-Authored-By: Mercury <https://mercury-cli.ai>\n'
  const c = runHook(attribution)
  check('the attribution trailer passes byte-unchanged', c.status === 0 && c.after === attribution, '', 'scripts/git-hooks/commit-msg must accept the exact trailer Co-Authored-By: Mercury <https://mercury-cli.ai> and leave the message unchanged')
  const d = runHook(clean + '\nCo-Authored-By: Mercury <https://mercury-cli.com>\n')
  check('a misspelled attribution trailer is refused (exit 1)', d.status === 1, '', 'scripts/git-hooks/commit-msg must exit 1 for a Mercury trailer that is not spelled exactly as Co-Authored-By: Mercury <https://mercury-cli.ai>')
  rmSync(hookDir, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ root guide: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ root guide: all checks passed')
