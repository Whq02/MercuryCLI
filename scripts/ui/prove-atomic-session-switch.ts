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

const headFn = door.slice(door.indexOf('async function workspaceOfTranscript('), door.indexOf('export function focusResumedSession('));
check(
  'the resume transcript head read is bounded (8 KB pread, never whole-file)',
  headFn.includes('fh.read(buf, 0, 8192, 0)') && !headFn.includes('readFileSync('),
);

const depsMatch = body.match(/\}, \[([^\]]+)\]\);\n/);
const deps = depsMatch?.[1] ?? '';
check(
  'deps include the live setters the callback closes over',
  deps.includes('addNotification') && deps.includes('removeNotification') && deps.includes('setToolJSX'),
  deps,
);

process.exit(fail);
