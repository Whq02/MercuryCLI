#!/usr/bin/env bun
// ============================================================================
//  prove-sync-spawn-bounds — every synchronous child spawn is bounded.
//
//  The hang class: Node runs one JS thread, so an unbounded spawnSync /
//  execFileSync / execSync freezes the ENTIRE process — rendering, timers,
//  keystrokes, and the process's own SIGINT handler, which needs the
//  blocked event loop to fire. Ctrl-C is dead; only an external kill
//  recovers. Three of these sat on the interactive boot road: the
//  executable resolver (whichSync, reached from the boot prefetch via git,
//  the doctor's binary lanes, $EDITOR and IDE resolution), the Windows
//  boot's own where.exe walk (every boot, before first paint), and the
//  macOS keychain's synchronous fallback — unbounded exactly when the
//  BOUNDED prefetch beside it had just timed out.
//
//  The law: every sync spawn's options carry a `timeout:`, or the call is
//  inventoried with the reason a bound would be wrong (an interactive
//  editor/pager on the user's own terminal must never be killed under
//  them). The inventory is per-file exact — a NEW unbounded call reds this
//  prover until it is bounded or consciously inventoried.
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// ── the exemption inventory: file → exact count of unbounded calls, why ─────
// Categories: interactive (stdio inherit — a timeout would kill the user's
// own editor/shell/pager under them) · terminal-ui (tmux attach/panel doors
// the operator sits inside).
const EXEMPT: Record<string, [number, string]> = {
  'src/utils/editor.ts': [2, 'interactive — the $EDITOR session runs on the user\'s terminal (stdio inherit); killing it under them loses their edit'],
  'src/utils/terminalPanel.ts': [2, 'interactive — tmux attach-session and the login shell the operator sits inside'],
  'src/utils/runtime/win32Console.ts': [1, 'bounded through chcpSpawnShape\'s built options (timeout: 5_000 rides the options variable the extractor cannot see through)'],
  'src/substrate/directSplash.ts': [1, 'interactive (stdio inherit — the launch splash asset IS the screen until the operator chooses; a bound would end the enter screen mid-choice)'],
}

const files = execSync(`grep -rln --include='*.ts' --include='*.tsx' -e 'spawnSync(' -e 'execFileSync(' -e 'execSync(' src`, {
  cwd: ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)
  .sort()

/** Extract each sync-spawn call's full argument text by balanced parens. */
function unboundedCalls(src: string): Array<{ line: number; head: string }> {
  const out: Array<{ line: number; head: string }> = []
  const re = /\b(spawnSync|execFileSync|execSync)\s*\(/g
  for (const m of src.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length
    let depth = 1
    let i = start
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      i++
    }
    const args = src.slice(start, i - 1)
    if (!/\btimeout\s*[:)]/.test(args) && !/\btimeout\b/.test(args)) {
      const line = src.slice(0, m.index).split('\n').length
      out.push({ line, head: src.slice(m.index, start + 60).split('\n')[0] ?? '' })
    }
  }
  return out
}

let sawAny = false
for (const file of files) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const bare = unboundedCalls(src)
  const exempt = EXEMPT[file]
  if (exempt !== undefined) {
    t(`inventoried ${file} (${exempt[0]}: ${exempt[1]})`, bare.length === exempt[0], `found ${bare.length} unbounded, inventoried ${exempt[0]}`)
    sawAny = true
    continue
  }
  if (bare.length > 0) {
    t(`${file} carries only bounded sync spawns`, false, bare.map(b => `L${b.line} ${b.head}`).join(' · '))
    sawAny = true
  }
}
t('the census walked a real population', files.length > 10, `${files.length} files`)
if (!sawAny) console.log('(every non-inventoried file is bounded)')

console.log(failures === 0 ? 'SYNC-SPAWN BOUNDS: ALL PASS' : 'SYNC-SPAWN BOUNDS: RED')
process.exit(failures)
