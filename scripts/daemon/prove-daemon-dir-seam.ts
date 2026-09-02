#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-daemon-dir-seam.ts
//  PROOF for the MERCURY_DAEMON_DIR hermetic seam (sophistication pass,
// — and the invariant-audit fix that extended it to the
//  run-record stores: runRecord's handoff sidecars and fireOutcomeLedger's
//  outcomes ledger each composed the daemon home through a PRIVATE configHome()
//  (join(configHome(), 'daemon', …)), bypassing daemonDir() — so a hermetic
//  proof daemon read the operator's REAL continuity into fired prompts and
//  wrote test rows into the real fire trail. The seam is only honest if
//  EVERY path under the daemon home resolves through daemonDir().
//
//  Legs:
//    1. BEHAVIORAL — daemonDir()/controlSockPath()/supervisorStatePath() and
//       the run-record path builders all redirect under MERCURY_DAEMON_DIR and
//       restore the config-home default when it is unset (env read LIVE).
//       Heavy import graphs degrade to the structural leg, loudly.
//    2. STRUCTURAL RATCHET — no daemon-home composition ("configHome…'daemon'")
//       exists in src outside controlSocket.ts, and src/daemon has no private
//       `function configHome(` clone outside controlSocket.ts (the exact shape
//       both bypasses grew from). ownedDaemon's <project>/.claude/daemon log
//       dir is EXEMPT by design (a per-project log, not the daemon home).
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-daemon-dir-seam.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const OVERRIDE = join('/tmp', 'hermes-seam-proof', 'daemon-home')

// ── Leg 1: behavioral — the seam redirects, live, everywhere ────────────────
section('1. MERCURY_DAEMON_DIR redirects every daemon-home path (live env read)')

const prevEnv = process.env.MERCURY_DAEMON_DIR
try {
  const cs = await import(join(ROOT, 'src', 'daemon', 'controlSocket.ts'))

  process.env.MERCURY_DAEMON_DIR = OVERRIDE
  check('daemonDir() honors the override', cs.daemonDir() === OVERRIDE, cs.daemonDir())
  check(
    'supervisorStatePath() lands under the override',
    (cs.supervisorStatePath() as string).startsWith(OVERRIDE + sep),
    cs.supervisorStatePath(),
  )

  delete process.env.MERCURY_DAEMON_DIR
  const defDir = cs.daemonDir() as string
  check(
    'unset ⇒ daemonDir() falls back to <configHome>/daemon',
    defDir.endsWith(sep + 'daemon') && !defDir.startsWith(OVERRIDE),
    defDir,
  )

  // (The fire-outcome ledger and run-record stores died with the legacy
  // engine; the seam's living consumers are pinned above.)

} finally {
  if (prevEnv === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = prevEnv
}

// ── Leg 2: structural ratchet — no bypass shape anywhere in src ─────────────
section('2. RATCHET: daemon-home composition exists ONLY in controlSocket.ts')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

const srcFiles = walk(join(ROOT, 'src'))
const composeRe = /configHome\s*(\(\s*\))?\s*,\s*['"]daemon['"]/
const composeHits: string[] = []
const cloneHits: string[] = []
for (const f of srcFiles) {
  const text = readFileSync(f, 'utf-8')
  if (composeRe.test(text)) composeHits.push(f)
  if (
    f.includes(sep + 'daemon' + sep) &&
    !f.endsWith('controlSocket.ts') &&
    /function configHome\s*\(/.test(text)
  ) {
    cloneHits.push(f)
  }
}
check(
  "join(configHome…, 'daemon') composed only by controlSocket.ts",
  composeHits.length === 1 && composeHits[0].endsWith('controlSocket.ts'),
  composeHits.map(f => f.slice(ROOT.length + 1)).join(', ') || 'no hits at all (seam moved? update this proof)',
)
check(
  'no private configHome() clone in src/daemon outside controlSocket.ts',
  cloneHits.length === 0,
  cloneHits.map(f => f.slice(ROOT.length + 1)).join(', '),
)

console.log('')
if (failures > 0) {
  console.log(`❌ daemon-dir seam proof: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ daemon-dir seam proof: all checks pass')
