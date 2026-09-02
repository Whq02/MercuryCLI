#!/usr/bin/env bun
// ============================================================================
//  scripts/dev-context/prove-root-guide.ts — the root guide and the commit
//  hygiene hook.
//
//   (1) AGENTS.md is the one root guide: present, a screen long, and carries
//       the sections a local-copy user needs (prerequisites, build and run,
//       the launcher and config home, checks, reporting a problem).
//   (2) CLAUDE.md is a two-line pointer whose first line is `@AGENTS.md`.
//   (3) No tool-specific developer estate is tracked (.claude/, .mercury/).
//   (4) The commit-msg hook strips session-metadata trailers, rejects
//       in-body session URLs, and passes model attribution untouched.
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

section('(1) AGENTS.md — the one root guide, a screen long, complete')
{
  const path = join(ROOT, 'AGENTS.md')
  check('AGENTS.md exists', existsSync(path))
  const guide = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = guide.split('\n').length
  check(`AGENTS.md stays a screen long (${lines} lines ≤ 80)`, lines <= 80)
  for (const [label, re] of [
    ['prerequisites', /^## Prerequisites/m],
    ['build and run', /^## Build and run/m],
    ['the launcher and the config home', /^## The launcher and the config home/m],
    ['checks', /^## Checks/m],
    ['reporting a problem', /^## Reporting a problem/m],
  ] as const) {
    check(`AGENTS.md carries the ${label} section`, re.test(guide))
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines?: { node?: string } }
  const range = pkg.engines?.node ?? ''
  check(`AGENTS.md states the supported Node range (${range})`, range !== '' && guide.includes(range))
  check('AGENTS.md names the build command', guide.includes('bun run build.ts'))
}

section('(2) CLAUDE.md — a two-line pointer at AGENTS.md')
{
  const path = join(ROOT, 'CLAUDE.md')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = text.replace(/\n$/, '').split('\n')
  check('CLAUDE.md exists', text !== '')
  check('CLAUDE.md is two lines', lines.length === 2, `${lines.length} lines`)
  check('the first line is @AGENTS.md', lines[0] === '@AGENTS.md')
}

section('(3) no tool-specific developer estate is tracked')
{
  const tracked = execFileSync('git', ['ls-files', '--', '.claude', '.mercury'], { cwd: ROOT, encoding: 'utf8' }).trim()
  check('nothing under .claude/ or .mercury/ is tracked', tracked === '', tracked.split('\n').slice(0, 3).join(', '))
}

section('(4) the commit-msg hook: strip trailers, reject body URLs, keep attribution')
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
  const clean = 'fix: a change\n\nBody prose explaining the durable reason.\n'
  const a = runHook(clean)
  check('clean message passes byte-unchanged', a.status === 0 && a.after === clean)
  const withTrailer = clean + 'Claude-Session: https://claude.ai/s/abc123\n'
  const b = runHook(withTrailer)
  check(
    'a session trailer is stripped (exit 0, trailer gone, rest intact)',
    b.status === 0 && !b.after.includes('Claude-Session') && b.after.includes('durable reason'),
  )
  const bodyUrl = 'fix: a change\n\nSee https://claude.ai/session/xyz for the transcript.\n'
  const c = runHook(bodyUrl)
  check('an in-body session URL is rejected (exit 1)', c.status !== 0)
  const attribution = clean + 'Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n'
  const d = runHook(attribution)
  check('Co-Authored-By attribution passes byte-unchanged', d.status === 0 && d.after === attribution)
  rmSync(hookDir, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ root guide: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ root guide: all checks passed')
