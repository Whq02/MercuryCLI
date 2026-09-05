#!/usr/bin/env bun
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

console.log('§2 deck-daemon-words — one snapshot owner; human words; no bare wire codes')
{
  const deck = read('src/components/DeckPane.tsx')
  const snap = read('src/utils/cockpit/daemonSnapshot.ts')
  check('POISON: the deck no longer reads the retired roster words', !deck.includes('implRoster'))
  check('the deck paints the daemon from the one snapshot owner', deck.includes('const daemon = daemonSnapshot()') && deck.includes('STATE_STYLE[daemon.state].glyph'))
  check('the reason reaches the deck only as the uptime it carries — never painted raw', deck.includes("daemon.reason?.match(/up (\\d+)s/)") && !/\{daemon\.reason\}/.test(deck))
  check('the owner speaks a human sentence for a wedged daemon (pid alive, socket unresponsive)', snap.includes('alive but control socket unresponsive'))
  check('the owner speaks a human sentence for a stale record', snap.includes('stale record · pid'))
  check("the owner speaks the opt-in sentence when no daemon runs", snap.includes('opt-in: run `mercury daemon`'))
  check('POISON: no reason is a bare wire code', !/reason: '(?:ENOCONN|ETIMEOUT|ESTARTING|EPROTO)'/.test(snap))
}

process.exit(failures === 0 ? 0 : 1)
