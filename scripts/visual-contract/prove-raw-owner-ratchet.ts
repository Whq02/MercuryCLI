#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const SANCTIONED: Record<string, string> = {
  'assets/splash/mercury-splash.mjs':
    'the pre-boot enter screen — user-facing BY DESIGN; its key contract is owned by the CN-03 activation gate + the CN-04 negative corpus in scripts/splash/prove-splash.py',
  'src/utils/earlyInput.ts':
    'the bounded pre-boot keystroke buffer — captures typed-ahead input before Ink boots, then hands the contract to the Ink stack (it deliberately leaves raw mode for the REPL)',
  'src/main.tsx':
    'boot-time piped-stdin intake (non-TTY prompt read with a bounded timeout) — a pipe reader, never a raw-mode UI owner',
  'src/services/dap/probeAdapter.ts': 'protocol pipe — the DAP wire rides stdio frames',
  'src/services/mcp/auth.ts':
    'credential prompt pipe — no-echo OAuth secret entry on a headless CLI path (Enter/Ctrl-C only), not a TUI surface',
  'src/utils/staticRender.tsx':
    'a raw-capable STUB stdin for one-frame string captures — a local EventEmitter that says isTTY and swallows setRawMode so the real component owners mount; process.stdin is never touched and no byte ever flows',
}

const USER_FACING = ['assets/splash/mercury-splash.mjs', 'src/utils/earlyInput.ts']

const PATTERN = /\bsetRawMode\b|stdin\.on\(\s*['"]data['"]/
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      yield* walk(p)
    } else if (EXTS.has(p.slice(p.lastIndexOf('.')))) {
      yield p
    }
  }
}

const isCommentLine = (line: string): boolean => {
  const s = line.trimStart()
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || s.startsWith('#')
}

const hits: string[] = []
const inkHits: string[] = []
for (const root of ['src', 'assets']) {
  for (const file of walk(root)) {
    let src: string
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!PATTERN.test(src)) continue
    if (
      file.startsWith('src/skills/bundled/') &&
      src.includes('export const SKILL_FILES: Record<string, string> = {')
    )
      continue
    const live = src.split('\n').some(l => PATTERN.test(l) && !isCommentLine(l))
    if (!live) continue
    if (file.startsWith('src/ink/')) inkHits.push(file)
    else hits.push(file)
  }
}
hits.sort()
inkHits.sort()

t.section('§1 — the census matches the sanctioned set exactly')
{
  const want = Object.keys(SANCTIONED).sort()
  const extra = hits.filter(h => !SANCTIONED[h])
  const missing = want.filter(w => !hits.includes(w))
  t.check(
    'no NEW raw-stdin owner outside the sanctioned set (route input through the Ink interpreter — src/ink input stack + the interaction-coverage registry; a genuinely new raw owner is a ratified act: add it here WITH its reason and its own key-contract proof)',
    extra.length === 0,
    extra.join(', ') || `${hits.length} owners, all sanctioned`,
  )
  t.check(
    'no sanctioned owner vanished silently (the ratchet updates deliberately)',
    missing.length === 0,
    missing.join(', ') || 'all present',
  )
  t.check(
    'the vendored Ink stack still owns app-side raw stdin (the census sees it)',
    inkHits.length > 0,
    `${inkHits.length} ink-stack sites`,
  )
}

t.section('§2 — the user-facing raw owners are exactly two')
{
  const facing = hits.filter(h => USER_FACING.includes(h)).sort()
  t.check(
    'user-facing raw input = {the splash asset, earlyInput} and nothing else',
    JSON.stringify(facing) === JSON.stringify([...USER_FACING].sort()),
    facing.join(', '),
  )
  for (const f of USER_FACING) {
    t.check(`${f} carries its sanction reason`, (SANCTIONED[f] ?? '').length > 0, SANCTIONED[f]?.slice(0, 60) ?? '')
  }
}

t.section('§3 — the splash activation gate is present at the source (CN-03)')
{
  const splash = readFileSync('assets/splash/mercury-splash.mjs', 'utf8')
  t.check(
    "the lockup branch gates on the bare-↵ press (isEnter = '\\r' | '\\n' | '\\r\\n')",
    splash.includes("const isEnter = s === '\\r' || s === '\\n' || s === '\\r\\n'"),
    'the CN-03 gate line',
  )
  const lockup = splash.slice(
    splash.indexOf("if (view === 'lockup') {"),
    splash.indexOf("if (s === '\\x1b') { view = 'lockup'; paintView(); return }"),
  )
  t.check(
    'the lockup branch has NO unguarded launch fall-through (launch only behind the isEnter gate)',
    lockup.length > 0 && lockup.split('launch()').length - 1 === 1 && /if \(isEnter\) \{\s*\n\s*leaving = true\s*\n\s*launch\(\)/.test(lockup),
    `${lockup.split('launch()').length - 1} launch() call(s) in the lockup branch`,
  )
}

t.finish('prove-raw-owner-ratchet')
