// prove-action-honesty — every visible control performs the action it
// implies, and async chrome paints last-known state (UI-logic
// audit, findings #9 + #10).
//
// Closed here:
//   a. Lanes rail: ACTIVE mission rows + the two +N overflow rows join the
//      selectable row model (they rendered as plain boxes beside selectable
//      queued rows — same look, dead to ↵/click); the SATURN wake glance is
//      a real row opening the schedules board (it printed the door as inert text), and
//      its sel() registration sits in visual order (before the TELEMETRY
//      glance build — the cursor-walk rule).
//   b. The prompt PREFILL channel (helmFocus): insert-at-cursor, never
//      submit — RealmsView's n/a/g/⌫ BEGIN their arg-bearing workflows
//      instead of printing a how-to; ↵ is labeled for its true consequence
//      (launch command).
// c. Async chrome snapshots: SessionTabs + the rail's RECENT lane seed
//      from scope-keyed last-known caches (project::session — another
//      project's rows can never flash), the wake glance from a global one;
//      errors are never cached.
process.env.NODE_ENV = 'test';

import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

// ── a. lanes rail rows ──────────────────────────────────────────────────────
const rail = readFileSync('src/components/HelmLanesRail.tsx', 'utf8');
check(
  'active mission rows are selectable RailRows',
  /label: `mission:a:\$\{t\.id\}`/.test(rail),
);
check(
  'both +N overflow rows are selectable',
  rail.includes("label: 'mission:a:more'") && rail.includes("label: 'mission:q:more'"),
);
check(
  // AMENDED: the owning board renamed to /saturn with the estate
  // with the estate; the selectable-row law is unchanged.
  'wake glance is a selectable row opening /saturn',
  rail.includes("command: '/saturn', label: 'wake:glance'"),
);
check(
  'wake row registers BEFORE the telemetry glance build (cursor-walk order)',
  rail.indexOf("label: 'wake:glance'") > 0 &&
    rail.indexOf("label: 'wake:glance'") < rail.indexOf('let glanceSection'),
);

// ── b. prefill channel ──────────────────────────────────────────────────────
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
// The launch-account arm (`/realms account`) retired with the station roster
// — the three surviving arms prefill.
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

// ── c. async chrome snapshots ───────────────────────────────────────────────
const tabs = readFileSync('src/components/mercury-ui/SessionTabs.tsx', 'utf8');
check(
  'SessionTabs seeds from a scope-keyed last-known cache',
  tabs.includes('const lastKnownTabs = new Map<string, LogOption[]>()') &&
    tabs.includes('rows: lastKnownTabs.get(scopeKey) ?? null'),
);
check(
  'SessionTabs swaps scopes in the SAME render (no cross-scope flash)',
  /if \(tabs\.key !== scopeKey\) \{\s*\n\s*setTabs\(\{ key: scopeKey/.test(tabs),
);
check(
  'SessionTabs never caches errors',
  /catch \{\s*\n\s*\/\/ Errors render as empty but are NOT cached/.test(tabs),
);
check(
  'rail RECENT lane seeds from its scope-keyed cache',
  rail.includes('const lastKnownRecent = new Map<string, LogOption[]>()') &&
    rail.includes('lastKnownRecent.get(recentScopeKey) ?? null'),
);
check(
  'wake glance seeds from its last-known snapshot',
  rail.includes('() => lastKnownWakeGlance') && rail.includes('lastKnownWakeGlance = next'),
);

process.exit(fail);
