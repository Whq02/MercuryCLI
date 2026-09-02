// prove-atomic-session-switch — the ONE session-switch chokepoint commits
// the visible switch in ONE synchronous step, with every await staged
// before it (UI-logic audit, finding #8 + the banked stale-closure report).
//
// The bug class: a flow that commits identity, then crosses awaits before
// the transcript swap, pairs the target's chrome with the source's
// transcript on the intermediate React commits. Under unification the
// switch is a HOP: the focused slot re-points at the target session's
// connector — one synchronous store write — and the face re-renders whole
// from that connector (records, asks, live turn, model) in the same batch.
//
// Contract proven here (source-structural; the LIVE end-to-end leg is
// prove-session-unification's U3, which drives the real binary through
// --resume and the next message):
//   1. A truthful `opening …` status shows before staging and leaves in the
//      same step as the outcome; failure swaps it for an honest error and
//      the slot stays where it was.
//   2. The commit is the slot re-point — setFocusedSessionConnector — and
//      NO await follows it inside the hop (attach first, then the one
//      synchronous write).
//   3. The staged work (the transcript attach, the daemon admission behind
//      the paint) precedes the commit; the admission never blocks the paint.
//   4. The screen's resume callback carries the live values it closes over
//      in its deps (no stale notification/dialog setters).
import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const repl = readFileSync('src/screens/REPL.tsx', 'utf8');
const start = repl.indexOf('const resume = useCallback(async (sessionId: UUID');
check('resume() found', start >= 0);
const bodyEnd = repl.indexOf('resumeRef.current = resume;', start);
const body = repl.slice(start, bodyEnd > start ? bodyEnd : start + 6000);

// ── 1. switching feedback lifecycle ─────────────────────────────────────────
check(
  'opening status shows before staging',
  /addNotification\(\{\s*key: 'session-switch',\s*text: `opening \$\{label\}…`/.test(body) &&
    body.indexOf("key: 'session-switch'") !== -1 && body.indexOf("key: 'session-switch'") < body.indexOf('await focusResumedSession('),
);
check(
  "status leaves with the outcome (removeNotification('session-switch'))",
  body.includes("removeNotification('session-switch')"),
);
check(
  'failure reports honestly and stays on the source session (no slot write on the failure arm)',
  body.includes('if (!outcome.ok) {') &&
    body.includes('the session could not be opened — ${outcome.reason}') &&
    !body.includes('setFocusedSessionConnector('),
);

// ── 2/3. the hop owner: attach staged, then ONE synchronous commit ──────────
const connector = readFileSync('src/services/engine-connector/daemonConnector.ts', 'utf8');
const hopStart = connector.indexOf('export async function focusDaemonSession(');
check('the hop owner found', hopStart >= 0);
const hop = connector.slice(hopStart, connector.indexOf('\n}\n', hopStart));
const commitAt = hop.indexOf('setFocusedSessionConnector(connector)');
check('the commit is the slot re-point (setFocusedSessionConnector)', commitAt >= 0);
check(
  'the attach is staged BEFORE the commit',
  hop.indexOf('await connector.attach()') >= 0 && hop.indexOf('await connector.attach()') < commitAt,
);
check(
  'ZERO awaits after the commit',
  commitAt >= 0 && (hop.slice(commitAt).match(/\bawait\s/g) ?? []).length === 0,
  `found ${(hop.slice(commitAt).match(/\bawait\s/g) ?? []).length}`,
);

// Re-cut to the landing-gate wrap: focusResumedSession is a sync wrapper now;
// the law lives in focusResumedSessionLanding — admission behind the paint,
// the route flip raced against the first-paint ceiling, the landing gate
// covering the tail.
const door = readFileSync('src/services/switchboard/hopIntoSession.ts', 'utf8');
const resumeStart = door.indexOf('async function focusResumedSessionLanding(');
const resumeBody = door.slice(resumeStart, door.indexOf('\n}\n', resumeStart));
check(
  'the daemon admission runs behind the paint (the records paint first, bounded by the first-paint ceiling)',
  resumeStart !== -1 &&
    resumeBody.includes('connector.awaitAdmission(refusal)') &&
    resumeBody.indexOf('const refusal = (async ()') !== -1 &&
    resumeBody.indexOf('const refusal = (async ()') < resumeBody.indexOf('await Promise.race([pointed') &&
    resumeBody.includes('const pointed = seat.focusDaemonSession(connector.record)'),
);

// The resume road's head read stays BOUNDED: workspaceOfTranscript reads the
// first 8 KB through one fd — a whole-file readFileSync decoded a transcript
// of any size on the cockpit thread just to keep 8192 chars (74 ms blocked
// for a 200 MiB transcript even warm-cached; the field's slow disks pay the
// multi-second class).
const headFn = door.slice(door.indexOf('async function workspaceOfTranscript('), door.indexOf('export function focusResumedSession('));
check(
  'the resume transcript head read is bounded (8 KB pread, never whole-file)',
  headFn.includes('fh.read(buf, 0, 8192, 0)') && !headFn.includes('readFileSync('),
);

// ── 4. deps carry the live values ───────────────────────────────────────────
const depsMatch = body.match(/\}, \[([^\]]+)\]\);\n/);
const deps = depsMatch?.[1] ?? '';
check(
  'deps include the live setters the callback closes over',
  deps.includes('addNotification') && deps.includes('removeNotification') && deps.includes('setToolJSX'),
  deps,
);

process.exit(fail);
