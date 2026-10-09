process.env.NODE_ENV = 'test';

import { existsSync, readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const rail = readFileSync('src/components/HelmLanesRail.tsx', 'utf8') + readFileSync('src/utils/cockpit/helmLanesModel.ts', 'utf8');
check(
  'the rail builds no ledger rows of its own (the TASKS card retired; RUNS opens /tasks)',
  !/mission:a:/.test(rail) && !/mission:q:/.test(rail) && !/section\('tasks'/.test(rail),
);
check(
  'wake glance is a selectable row opening /saturn',
  rail.includes("command: '/saturn', label: 'wake:glance'"),
);
check(
  'wake row registers BEFORE the vitals glance build (cursor-walk order)',
  rail.indexOf("label: 'wake:glance'") > 0 &&
    rail.indexOf("label: 'wake:glance'") < rail.indexOf('const glanceSection') &&
    /saturnSection\(\), glanceSection\(\)\]/.test(rail),
);

const { requestPromptPrefill, consumePromptPrefill } = await import(
  '../../src/utils/cockpit/helmFocus.js'
);
requestPromptPrefill('/realms add ');
check('prefill channel: request → consume returns the text', consumePromptPrefill() === '/realms add ');
check('prefill channel: consume is one-shot', consumePromptPrefill() === null);
const promptInput = readFileSync('src/components/PromptInput/PromptInput.tsx', 'utf8');
check(
  'PromptInput consumes the prefill as INSERT-AT-CURSOR, never a submit',
  promptInput.includes('const prefill = consumePromptPrefill()') &&
    /if \(prefill !== null\) \{\s*setHelmFocus\('prompt'\)\s*insertAtCursor\(prefill\)/.test(promptInput),
);
const realms = readFileSync('src/components/mercury-ui/parity/RealmsView.tsx', 'utf8');
check(
  "RealmsView ↵ labeled for its true consequence ('launch command')",
  realms.includes("hint: 'launch command'"),
);
check(
  'RealmsView n/g/⌫ BEGIN their workflows via prefill',
  realms.includes("prefillAndClose('/realms add ')") &&
    realms.includes("prefillAndClose('/realms clone ')") &&
    realms.includes('prefillAndClose(`/realms revoke ${r.name} `)'),
);
check(
  'clone stays gated on the real auth probe (unauthed ⇒ honest note, no prefill)',
  /if \(!gh\.authed\) return gh\.note/.test(realms),
);

check(
  'the sessions strip is gone: no module under src seeds a tabs cache',
  !existsSync('src/components/mercury-ui/SessionTabs.tsx'),
);
check(
  'rail RECENT lane seeds from its scope-keyed cache',
  rail.includes('const lastKnownRecent = new Map<string, SessionListing[]>()') &&
    rail.includes('lastKnownRecent.get(recentScopeKey) ?? null'),
);
check(
  'wake glance seeds from its last-known snapshot',
  rail.includes('() => lastKnownWakeGlance') && rail.includes('lastKnownWakeGlance = next'),
);

process.exit(fail);
