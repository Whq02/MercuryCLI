// ============================================================================
//  scripts/golden-journeys/j3State.ts — the shared "substantial multi-stage" seeded
//  state (J3 walks it; J4 restarts it; J5 intervenes in it).
//
//  Five dependent work items in the REAL task-ledger shape + an ACTIVE run
//  sidecar folded through the real kernel reducer (2 done · 1 in-progress ·
//  2 open, one dependency-blocked), two observed changed paths, STALE
//  verification (a mutation after the last green check), and a seeded
//  next action. The distinctive item subjects are the frozen probe needles.
// ============================================================================

import {
  bashRound,
  conversationRows,
  editRound,
  foldRun,
  seedTasks,
  writeRunSidecar,
  writeSession,
} from './journeyLib.ts'

export const J3_OBJECTIVE = 'Modernize the fixture demo end to end'

export const J3_ITEMS = [
  { id: '1', subject: 'sketch the modernization plan', status: 'completed' as const },
  { id: '2', subject: 'rework the greeting module', status: 'completed' as const },
  { id: '3', subject: 'wire the config loader', status: 'in_progress' as const },
  { id: '4', subject: 'document the new commands', status: 'pending' as const },
  { id: '5', subject: 'publish the release notes', status: 'pending' as const, blockedBy: ['4'] },
]

export const J3_NEXT_ACTION = 'continue the open deliverable: wire the config loader'

export function seedSubstantialState(sid: string): void {
  writeSession(
    sid,
    conversationRows(
      sid,
      J3_OBJECTIVE,
      [
        editRound('src/greet.ts', 'return `hello`', 'return `hello, ${name}`', `toolu_${sid.slice(-2)}_edit1`),
        bashRound('./check.sh alice', 'Run the fixture check', 'PASS', `toolu_${sid.slice(-2)}_bash1`),
      ],
      'Plan items 1–2 are landed; wiring the config loader next.',
    ),
  )
  seedTasks(sid, J3_ITEMS)
  const t0 = Date.parse('2026-07-20T12:00:00.000Z')
  writeRunSidecar(
    sid,
    foldRun(sid, `run_momentum_${sid.slice(-2)}`, J3_OBJECTIVE, [
      { type: 'substantive', at: t0 + 1000, reason: 'invoked Edit' },
      ...J3_ITEMS.map((item, i) => ({
        type: 'task-transition' as const,
        at: t0 + 2000 + i * 1000,
        taskId: item.id,
        title: item.subject,
        state:
          item.status === 'completed'
            ? ('done' as const)
            : item.status === 'in_progress'
              ? ('in-progress' as const)
              : ('open' as const),
      })),
      {
        type: 'tool-effected',
        at: t0 + 8000,
        toolName: 'Edit',
        toolUseId: `toolu_${sid.slice(-2)}_edit1`,
        operation: 'edit apply',
        outcome: 'succeeded',
        changedPaths: ['src/greet.ts', 'README.md'],
      },
      { type: 'phase', at: t0 + 9000, phase: 'implementation', reason: 'plan items landing' },
      {
        type: 'evidence',
        at: t0 + 10_000,
        state: 'stale',
        detail: 'tree changed after the last green check',
      },
      { type: 'next-action', at: t0 + 11_000, action: J3_NEXT_ACTION },
    ]),
  )
}
