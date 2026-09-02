// prove-consent-queue-marker — a stacked consent sequence never masquerades as
// a single request.
//
// The bug class: REPL keeps a QUEUE of pending tool approvals but renders only
// the head card with no position marker — three stacked requests were
// indistinguishable from one. The common notification string also still said
// "Hermes" .
//
// Contract proven here:
//   1. permissionQueueStatus (pure sequence math) — position/total across a
//      resolve sequence, including mid-sequence arrivals.
//   2. PermissionDialog consumes PermissionQueueContext and hides the marker
//      for a lone request (total <= 1 ⇒ byte-identical card).
//   3. REPL wires the provider around the head PermissionRequest, advances
//      resolvedConsentCount in the SAME handler as the queue pop (no blank
//      frame), and resets when the queue drains.
//   4. The notification copy names Mercury; no "Hermes needs/wants/requested"
//      residue anywhere under src/components/permissions/.
process.env.NODE_ENV = 'test';

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

// ── 1. pure sequence math ───────────────────────────────────────────────────
const { permissionQueueStatus } = await import(
  '../../src/components/permissions/PermissionQueueContext.js'
);
const seq = [
  permissionQueueStatus(0, 3), // 3 queued, none resolved
  permissionQueueStatus(1, 2), // first allowed
  permissionQueueStatus(2, 1), // second allowed
];
check('3-request sequence reads 1/3 → 2/3 → 3/3',
  seq[0]!.position === 1 && seq[0]!.total === 3 &&
  seq[1]!.position === 2 && seq[1]!.total === 3 &&
  seq[2]!.position === 3 && seq[2]!.total === 3,
  JSON.stringify(seq));
const grown = permissionQueueStatus(1, 3); // a new request arrived mid-sequence
check('mid-sequence arrival grows total truthfully (2/4)',
  grown.position === 2 && grown.total === 4, JSON.stringify(grown));
const lone = permissionQueueStatus(0, 1);
check('lone request is 1/1 (marker hidden by the total>1 gate)',
  lone.position === 1 && lone.total === 1);

// ── 2. dialog consumption + hide gate ───────────────────────────────────────
const dialog = readFileSync('src/components/permissions/PermissionDialog.tsx', 'utf8');
check('PermissionDialog consumes PermissionQueueContext',
  dialog.includes('React.useContext(PermissionQueueContext)'));
check('marker hidden for a lone request (total > 1 gate)',
  dialog.includes('queueStatus.total > 1'));
check('marker renders position/total in the title row',
  dialog.includes('{queueStatus.position}/{queueStatus.total}'));
check('marker sits in the titleRight/modeChip cluster',
  /\{titleRight\}\s*\{queueMarker\}\s*\{modeChip\}/.test(dialog));

// ── 3. REPL wiring ──────────────────────────────────────────────────────────
const repl = readFileSync('src/screens/REPL.tsx', 'utf8');
check('provider wraps the head PermissionRequest',
  repl.includes('<PermissionQueueContext.Provider value={permissionQueueStatus(resolvedConsentCount, toolUseConfirmQueue.length)}>'));
check('resolve advances the sequence in the same handler as the settle (the connector owns the pop)',
  /setResolvedConsentCount\(c => c \+ 1\);[\s\S]{0,220}focused\.settleAsk\(head\.id\)/.test(repl));
check('sequence resets when the queue drains',
  repl.includes('if (toolUseConfirmQueue.length === 0) setResolvedConsentCount(0);'));

// ── 4. Mercury copy on the notification path ────────────────────────────────
const permReq = readFileSync('src/components/permissions/PermissionRequest.tsx', 'utf8');
check('notification names Mercury',
  permReq.includes('Mercury needs your permission to use'));
let residue = '';
try {
  residue = execFileSync('grep', ['-rn', '-E', 'Hermes (needs|wants|requested)', 'src/components/permissions/'], { encoding: 'utf8' });
} catch {
  /* grep exits 1 on no match — that's the pass */
}
check('no "Hermes needs/wants/requested" residue in the consent surface',
  residue.trim() === '', residue.trim());

process.exit(fail);
