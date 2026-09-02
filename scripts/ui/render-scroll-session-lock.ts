// ============================================================================
//  render-scroll-session-lock — scroll-to-top REVEALS the critter hero.
//  There is no scroll wall at listOrigin and no scroll-floor primitive
//  anywhere (no useVirtualScroll floor, ScrollBox handle, DOMElement
//  field, compose-walk wall, or keybinding landing): the persistent-hero
//  contract makes the pre-list chrome — with turns, the living
//  critter + a one-line ✶ Mercury brand row — identity, not furniture,
//  and it stays reachable by scroll.
//
//  Contract under test, after PageUp spam on a 30-turn resumed session:
//   • the critter hero IS visible (≥60 half-block cells — the
//     prove-persistent-hero threshold) with the ✶ Mercury brand row;
//   • the furniture stays collapsed (no wordmark, no tagline — the
//     anti-junk half of the collapse survives);
//   • turn 1 is on screen directly below the header;
//   • scrollTop RESTS at 0 (the renderer's natural top clamp consumes
//     overshoot — no banked delta deadening scroll-down).
//  PTY-booting proof (≈18s): joins the suite under UI_RENDER=1.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bigWordmarkRows } from '../../src/components/mercury-ui/assets.js'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts/ui/vshot.py')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — the fixture below and the spawned binary share it.
const CONFIG_HOME = resolveProofHome([REPO.normalize('NFC')])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(REPO.normalize('NFC')))
// Distinct SID namespace (…-eeee-…) so concurrent suite runs can't race the
// shared renderScenarios fixtures (audit U20 pattern).
const SID = `00000000-aaaa-bbbb-eeee-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`

const base = (extra: Record<string, unknown>) => ({
  isSidechain: false, userType: 'external', entrypoint: 'cli',
  cwd: REPO, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})
const lines: unknown[] = []
let prev: string | null = null
for (let i = 1; i <= 30; i++) {
  const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  lines.push(base({
    parentUuid: prev, type: 'user', uuid,
    message: { role: 'user', content: `turn ${i}: probe message body padding the row out for realism` },
    timestamp: `2026-06-19T12:00:${String(i).padStart(2, '0')}.000Z`,
  }))
  prev = uuid
}
if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
const fixture = join(PROJECTS, `${SID}.jsonl`)
writeFileSync(fixture, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

const PAGEUP = '\x1b[5~'
const sends = Array.from({ length: 16 }, (_, i) => ({ atTick: 45 + i * 2, data: PAGEUP }))
const grid = '/tmp/scroll-session-lock-grid.json'
const commits = '/tmp/scroll-session-lock-commits.jsonl'
const cfgPath = '/tmp/scroll-session-lock-cfg.json'
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--resume', SID], sends, total: 90, cols: 120, rows: 44, out: grid }))
try { rmSync(commits) } catch { /* fresh */ }
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf-8', timeout: vshotBudgetMs(150000),
  env: {
    ...process.env,    // Split-home guard (pinned home): this proof writes its
    // fixture under CONFIG_HOME (the proof's own home) — the fork child, env-less,
    // resolves ITS OWN ~/.mercury since and booted onto "No
    // conversation found" (the suite's one silent RED after the home flip;
    // every scenario()-based sibling already pins this).
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    // Liveness pin (the alive-REPL pass): this proof needles '✶ Mercury', and
    // the standing sigil GLINTS to ✦ ~2.8% of instants when armed — pin the
    // static frame like every scenario()-based sibling (frame 0 IS ✶).
    MERCURY_LIVE_GLYPHS: '0',
    INK_COMMIT_TEE: commits,
  },
})
try { rmSync(fixture) } catch { /* cleanup */ }
if (res.status !== 0) {
  console.error(`✗ vshot failed: ${res.stderr?.slice(0, 300)}`)
  process.exit(1)
}

const g = JSON.parse(readFileSync(grid, 'utf8'))
const rows: string[] = g.grid.map((line: Array<{ c: string }>) => line.map(c => c.c).join(''))
const joined = rows.join('\n')
let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}
// The living critter at the top: half-block cell art (≥60 cells — the
// prove-persistent-hero presence threshold) + the banner-header (single-brand
// pass: the block MERCURY banner IS the turns furniture at this
// geometry — pin its exact first letterform row).
const halfBlocks = (joined.match(/[▀▄]/g) ?? []).length
check(halfBlocks >= 60, `critter hero visible after PageUp spam (${halfBlocks} half-block cells)`)
check(joined.includes(bigWordmarkRows()[0]!.trimEnd()), 'banner-header visible with the hero')
// The landing-only furniture stays collapsed with turns (the anti-junk half
// of the collapse): no tagline, no session table.
check(!joined.includes('mission control'), 'landing tagline stays collapsed')
// The session start sits directly below the header — reachable in the SAME
// viewport as the hero, not walled off and not pushed out.
check(joined.includes('turn 1:'), 'first message on screen below the header')
// Rest position: scrollTop must REST at the natural top (0) — the renderer's
// 0-clamp consumes overshoot, so scroll-down responds immediately (the old
// floor's write-back duty, now carried by the top clamp).
const commitLines = readFileSync(commits, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const tail = commitLines.filter(c => c.scroll?.top !== undefined).slice(-3)
check(
  tail.length > 0 && tail.every(c => c.scroll.top === 0),
  `scrollTop rests at the natural top (${JSON.stringify(tail.at(-1)?.scroll)})`,
)
console.log(failures === 0 ? '✅ scroll-to-top hero GREEN' : `❌ scroll-to-top hero RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
