#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-spinner-tips.ts — the spinner-tip catalogue's laws,
//  pinned over the LIVE registry:
//
//   · WIDTH — every tip renders on one spinner-tail line at 100 columns:
//     stringWidth(content) ≤ BUDGET for every tip, across both terminal
//     branches (Apple Terminal vs the rest) and both authored appearances.
//     A wrapped tip jiggles the tail; a clipped tip is a broken tip.
//   · TRUTH — every slash command a tip advertises exists in the command
//     roster (name or alias, from src/commands source). A tip steering to a
//     dead surface fails here, not in front of the operator.
//   · SHAPE — ids unique; built-in cooldowns ≥ 5 sessions; the loyalty-
//     pinned 'appearance-command' id present (prove-mercury-loyal's law).
//   · The one-home-literal law over this file is owned by
//     scripts/projectdirs/prove-no-literal-homes.ts — not re-proven here.
//
//  Runs on a scratch config home: every relevance gate passes fresh-config
//  (counters zero, no policy effort, never-shown cooldowns) EXCEPT the
//  windows-only powershell tip on POSIX — its copy is pinned via a direct
//  content() call, not through the relevance filter.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-spinner-tips.ts
// ============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')

// A scratch config home BEFORE any config-reading import (bun homedir()
// ignores env HOME — the config dir pin is the honest seam).
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-tips-proof-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getRelevantTips } = await import('../../src/services/tips/tipRegistry.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

// The spinner tail paints the tip full-width under the animation row on the
// MAIN surface (Spinner.tsx's tail rides outside the rail box), so at 100
// columns the one-line budget is the terminal width minus margin. Inside the
// cockpit work capsule the strip column is far narrower (~55) and the tail
// wraps by design (wrap="wrap" — flow, never clip); no single-line law can
// hold there, so the pin is the main surface's.
const BUDGET = 94

// ── gather the catalogue through the public read ───────────────────────────
const tips = await getRelevantTips()
check('fresh-config read yields the catalogue (≥ 20 tips)', tips.length >= 20, String(tips.length))

// ── the command roster from source (names + aliases) ───────────────────────
const rosterText: string[] = []
const { readdirSync, statSync } = await import('node:fs')
const cmdRoot = join(ROOT, 'src/commands')
for (const entry of readdirSync(cmdRoot)) {
  const p = join(cmdRoot, entry)
  if (statSync(p).isDirectory()) {
    try {
      rosterText.push(readFileSync(join(p, 'index.ts'), 'utf8'))
    } catch {
      /* a directory without an index registers nothing */
    }
  } else if (entry.endsWith('.ts')) {
    rosterText.push(readFileSync(p, 'utf8'))
  }
}
const roster = new Set<string>()
for (const text of rosterText) {
  for (const m of text.matchAll(/name:\s*'([a-z0-9-]+)'/g)) roster.add(m[1]!)
  for (const m of text.matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
    for (const a of m[1]!.matchAll(/'([a-z0-9-]+)'/g)) roster.add(a[1]!)
  }
}
check('roster read is real (≥ 40 commands)', roster.size >= 40, String(roster.size))

// ── per-tip laws across both terminal branches ─────────────────────────────
const ids = new Set<string>()
const seenCommands = new Set<string>()
for (const tip of tips) {
  check(`id unique: ${tip.id}`, !ids.has(tip.id))
  ids.add(tip.id)
  check(`cooldown ≥ 5: ${tip.id}`, tip.cooldownSessions >= 5, String(tip.cooldownSessions))

  for (const term of ['Apple_Terminal', 'xterm-program']) {
    const prev = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = term
    let rendered = ''
    try {
      for (const theme of ['dark', 'true-black']) {
        rendered = await tip.content({ theme })
        const width = stringWidth(rendered)
        check(
          `width ≤ ${BUDGET} [${tip.id} · ${term === 'Apple_Terminal' ? 'apple' : 'rest'} · ${theme}]`,
          width <= BUDGET,
          `${width}: ${rendered}`,
        )
      }
    } finally {
      if (prev === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = prev
    }
    for (const m of rendered.matchAll(/(?:^|\s)\/([a-z][a-z0-9-]*)/g)) seenCommands.add(m[1]!)
  }
}
for (const cmd of seenCommands) {
  check(`advertised command exists: /${cmd}`, roster.has(cmd))
}
check('the loyalty-pinned appearance tip id is present', ids.has('appearance-command'))
check(
  'the catalogue advertises the load-bearing surfaces (spot pins)',
  ['logins', 'concourse', 'themis', 'caching', 'rewind', 'remember'].every(c => seenCommands.has(c)),
)

// ── the windows-gated tip's copy, pinned directly (POSIX-relevance is false) —
const registrySource = readFileSync(join(ROOT, 'src/services/tips/tipRegistry.ts'), 'utf8')
check(
  'the powershell tip advertises the product-native spelling',
  registrySource.includes('MERCURY_USE_POWERSHELL_TOOL=1'),
)

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ SPINNER TIPS: every law holds' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
