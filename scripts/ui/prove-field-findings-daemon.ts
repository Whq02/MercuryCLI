#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-daemon.ts
// TASK-017 SUPPLEMENT 3 fixes — the /daemon roster.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-daemon.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── §1 · a settled seat never wears the idle costume ────────────────────────
// Finding daemon-settled-worker-idle-costume (important): the roster skips
// the busy bit for a settled entry, so a DEGRADED/crashed/killed seat derived
// busy=false, painted '●' in neutral sage and the word 'idle' — byte-identical
// to a healthy waiting seat; the wire's `outcome` never entered the row. The
// derive carries it and the row paints outcome FIRST (the deck's own law).
console.log('§1 daemon roster — outcome first')
{
  const { deriveSupervisorRows } = await import('../../src/utils/cockpit/daemonSupervisorRows.ts')
  const status = {
    supervisor: { pid: 4242, version: '0.0.0', uptimeSec: 10, dir: '/tmp/x' },
    controlSock: '/tmp/x/control.sock',
    controlReachable: true,
    workersLive: 1,
    workersTotal: 2,
    breakerOpen: false,
    maxInflight: 2,
    leaseCount: 0,
    proto: 1,
    degraded: false,
    warmRunners: 0,
    fireOutcomes: null,
    handshake: null,
    versionLine: null,
    workers: [
      { short: 'impl-1', sessionId: 's1', prompt: '', source: 'cron', state: 'crashed', startedAt: 0, cliVersion: '0', outcome: 'degraded', respawns: 3 },
      { short: 'impl-2', sessionId: 's2', prompt: '', source: 'cron', state: 'running', startedAt: 0, cliVersion: '0', busy: false },
    ],
  } as unknown as Parameters<typeof deriveSupervisorRows>[0]
  const rows = deriveSupervisorRows(status).workers
  check('the derive carries the wire outcome on the settled seat and none on the live one', rows[0]?.outcome === 'degraded' && rows[1]?.outcome === undefined, JSON.stringify(rows.map(r => r.outcome)))
  check('a settled seat is never busy', rows[0]?.busy === false)
  const view = read('src/components/mercury-ui/parity/DaemonSupervisorView.tsx')
  check("the row's activity reads the outcome first — never 'idle' for a settled seat", view.includes('const settled = w.outcome !== undefined') && view.includes('? `${GLYPH.fail} ${w.outcome}`') && view.includes('`settled · ${w.outcome}`'))
  check('a failed outcome (degraded · crashed · killed) leads with the failure glyph in the failure ink', view.includes("const failed = w.outcome === 'degraded' || w.outcome === 'crashed' || w.outcome === 'killed'") && view.includes('{failed ? GLYPH.fail : w.busy ? GLYPH.inProgress : GLYPH.done}') && view.includes('const leadInk = failed ? CRIMSON :'))
  check('POISON: the busy-only lead is gone', !view.includes("<Text color={w.stalled ? AMBER : w.busy ? TEAL : SECOND}>\n                      {w.busy ? GLYPH.inProgress : GLYPH.done}"))
  check('the roster still withholds the busy bit from a settled entry (the wire truth the row now reads)', read('src/daemon/roster.ts').includes('if (!h.entry.outcome) {\n          e.busy = !this.seatIsIdle(h.longLived)'))
}
// NEEDS-REAL-BOX: /daemon against a supervisor whose long-lived seat exhausted
// its respawn budget — the row leads ✕ in crimson and reads the outcome.

// ── §2 · deck-estarting — the deck's daemon words are true ──────
// The finder: the deck reported a STARTING daemon as 'offline (no daemon)'
// and leaked raw wire codes for the rest. crewClient's own vocabulary:
// ESTARTING = a booting daemon (~1-2s pipe bind) — it now says
// 'daemon starting…'; ENOCONN/ETIMEOUT keep the honest offline words; an
// unrecognised code paints 'unreachable (<code>)' — a human word first,
// the code preserved, never bare.
console.log('§2 deck-estarting — starting says starting; no bare wire codes')
{
  const deck = read('src/components/DeckPane.tsx')
  check("ESTARTING reads 'daemon starting…'", deck.includes("implRoster.reason === 'ESTARTING' ? 'daemon starting…'"))
  check('ENOCONN/ETIMEOUT keep the offline words', deck.includes("implRoster.reason === 'ENOCONN' || implRoster.reason === 'ETIMEOUT' ? 'offline (no daemon)'"))
  check("the residual arm wraps the code — 'unreachable (…)', never bare", deck.includes('`unreachable (${implRoster.reason})`'))
  check('POISON: ESTARTING no longer collapses into the offline arm', !/'ENOCONN' \|\| implRoster\.reason === 'ETIMEOUT' \|\| implRoster\.reason === 'ESTARTING'/.test(deck))
}

process.exit(failures === 0 ? 0 : 1)
