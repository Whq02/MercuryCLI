// prove-manager-mode — MANAGER MODE (coordinator-tooling ledger T7+T8): the
// coordinator composer's shift+tab station, the 1–5 interview cards with the
// RULED number semantics, the plan card's one Yes, the harmony fields, and
// supervising-light on existing plumbing.
//
// Contract proven here:
//   1. THE MODE cycles on the coordinator composer WHENEVER IT EXISTS (ledger
//      L22): the shift+tab manager branch is guarded on the focused
//      coordinator region and the full stage ALONE — in BOTH coordinator
//      modes (the old coordinatorOn gate, which let the operator's shift+tab
//      fall to the ring's backward step in the self-managed world, is the
//      poison); every other region keeps the ring; the reduced stage and the
//      main REPL never see it. In the self-managed world a send is the
//      manager's turn on the composed coordinator model — never a direct
//      launch — and with no model chosen the honest line names the pick.
//   2. NUMBER-SELECTS-NEVER-ADVANCES (poison: a number that advances): the
//      interview card turns the select owner's own digit-commit OFF
//      ('numeric') and its card-level digit branch only moves focus — no
//      commit call lives in it; ↵ commits through the owner's accept.
//   3. 5-FOCUSES-CUSTOM: the custom option is the trailing INPUT row; its
//      ordinal falls inside the card's select range, and the owner derives
//      isInInput from the focused input option, so the selecting digit also
//      lands typing in the field.
//   4. THE ONE YES: the overload ask still fires — the Yes path gates on
//      the PLAN's demand BEFORE any dispatch op — and each lane's contract
//      rides the SAME consent through the landed verb immediately behind
//      its lane's dispatch (the ledger-T2 birth-then-set sequencing: the
//      daemon's contract verb needs the born session; the agreement's words
//      ALSO ride the lane's first message, so the contract precedes all
//      work). No/esc dispatches NOTHING and keeps the draft.
//   5. THE HARMONY LAW: every lane carries scope · deliverables · TERRITORY
//      (a territory-less lane refuses whole), the card paints the fences,
//      and the addendum carries the law in the estate's advisory grammar.
//   6. SUPERVISING-LIGHT: a pure fold owes idempotent land/needs-you rows;
//      launch-only appends nothing; no watcher machinery of its own.
process.env.NODE_ENV = 'test';

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const screen = readFileSync('src/components/concourse/ConcourseScreen.tsx', 'utf8');
const cards = readFileSync('src/components/concourse/ManagerCards.tsx', 'utf8');
const selectInput = readFileSync('src/components/CustomSelect/use-select-input.ts', 'utf8');
const navigation = readFileSync('src/components/CustomSelect/use-select-navigation.ts', 'utf8');

// ── 1. the mode cycles on the coordinator composer whenever it exists (L22) ──
check('the shift+tab manager branch is guarded on the focused coordinator region + the full stage ALONE (both coordinator modes)',
  /key\.shift && region === 'coordinator' && !reducedStage\) \{/.test(screen));
check('POISON: no coordinatorOn gate on the toggle (the self-managed world fell to the ring step — the operator\'s report)',
  !/key\.shift && region === 'coordinator' && coordinatorOn/.test(screen));
const toggles = screen.match(/setManagerArmed\(arming\)/g) ?? [];
check('exactly ONE mode toggle exists and it lives inside that guard, flipping its ref synchronously (no second door)',
  toggles.length === 1 && !screen.includes('setManagerArmed(v => !v)') &&
    /key\.shift && region === 'coordinator' && !reducedStage\) \{\s*const arming = !managerOnRef\.current\s*managerOnRef\.current = arming\s*setManagerArmed\(arming\)/.test(screen),
  `toggle sites: ${toggles.length}`);
check('every other region keeps the ring backward step (dir still forks on shift)',
  screen.includes('const dir = key.shift ? -1 : 1'));
check('the reduced stage derives the mode OFF; the coordinator\'s own mode is NOT a gate (L22)',
  screen.includes('const managerOn = managerArmed && !reducedStage') &&
    !screen.includes('managerArmed && !reducedStage && coordinatorOn'));
check('the meta row advertises ⇧tab on the full stage in both modes (the glyph pass law)',
  /const coordinatorKeysHint = !reducedStage\s*\?/.test(screen));
check('a manager send in the self-managed world never direct-launches (the launch branch is fenced on !managerOnRef)',
  screen.includes('if (!coordinatorOn && !managerOnRef.current) {'));
check('…and reads the manager model BEFORE the send — no model ⇒ the note names the pick and the draft stays',
  /if \(!coordinatorOn\) \{[\s\S]{0,700}?resolveManagerModel\(\)[\s\S]{0,400}?if \(!model\.ok\) \{\s*setNote\(\{ tone: 'warning', text: model\.line \}\)\s*return/.test(screen));
check('arming in the self-managed world speaks the honest first line at once (noteManagerModel)',
  screen.includes('if (!coordinatorOn) noteManagerModel(arming)'));
const lane = readFileSync('src/services/concourse/coordinatorLane.ts', 'utf8');
const mgrSrcEarly = readFileSync('src/services/concourse/managerMode.ts', 'utf8');
check('the manager model resolves through the composed registry (validateCoordinatorModelChoice), never a guessed id',
  mgrSrcEarly.includes('export async function resolveManagerModel') && mgrSrcEarly.includes('validateCoordinatorModelChoice(choice)'));
check('the lane runs the manager turn on that model in the self-managed world, AHEAD of the direct-launch hint branch',
  lane.indexOf('resolveManagerModel()') !== -1 && lane.indexOf('resolveManagerModel()') < lane.indexOf("id: 'co:hint:coordinator-off'") &&
    lane.includes("effective.resolution.effective !== 'agent-assisted' && managerModel === null"));
check('no model ⇒ the pane gets a HARNESS row with the honest line + a typed not-assisted receipt (never a crash, never a launch)',
  /if \(managerModel !== null && !managerModel\.ok\) \{[\s\S]{0,400}?harness: true[\s\S]{0,300}?outcome: 'not-assisted'/.test(lane));
check('the assisted turn honours the manager model override without lifting the coordinator mode',
  lane.includes('deps.manager === true && deps.managerModelId !== undefined'));
check('the composer wears the mode (the ∷ modeBand + the mode-scoped rest hint)',
  screen.includes('GLYPH.modeManager') && screen.includes('manager mode on') &&
  screen.includes('the manager interviews, then plans the lanes'));
check('the meta row prints true keys in both stations (⇧tab manager / ⇧tab chat mode)',
  screen.includes('⇧tab manager') && screen.includes('⇧tab chat mode'));
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.js');
check('the manager seal exists in the one glyph vocabulary (∷, width-1 dialect)',
  GLYPH.modeManager === '∷');
let replResidue = '';
try {
  replResidue = execFileSync('grep', ['-rn', '-E', 'managerMode|ManagerCards|MANAGER_MODE', 'src/screens/'], { encoding: 'utf8' });
} catch {
  /* no match — the pass */
}
check('the main REPL never sees manager mode (coordinator REPL only)', replResidue.trim() === '', replResidue.trim());
let importers = '';
try {
  importers = execFileSync('grep', ['-rln', 'ManagerCards.js', 'src/'], { encoding: 'utf8' });
} catch {
  /* unreachable — the screen imports it */
}
check('the cards mount from the concourse screen alone',
  importers.trim() === 'src/components/concourse/ConcourseScreen.tsx', importers.trim());

// ── 2. number-selects-never-advances (the lead's hold, to the letter) ───────
//    The operator's words: "pressing four shouldn't just, like, go next — it
//    should select". A digit press NEVER commits or advances in the same
//    keystroke — even when the digit lands on the already-selected option
//    (a double press is never a commit shortcut); only ↵ commits.
const mgrEarly = await import('../../src/services/concourse/managerMode.js');
const FIVE = { optionCount: 5, inInput: false }; // 4 proposed + the custom fifth
const digitActions = ['1', '2', '3', '4', '5'].map(d => mgrEarly.askCardKeyAction(d, FIVE));
check('digits 1–5 each SELECT their option (highlight) — none commits, none advances',
  digitActions.every((a, i) => a.kind === 'select' && a.index === i), JSON.stringify(digitActions));
// The already-selected case: the fold has no memory of focus BY DESIGN — a
// second press of the selected option's digit is the same idempotent select,
// so no keystroke sequence of digits can ever reach a commit.
const twice = [mgrEarly.askCardKeyAction('4', FIVE), mgrEarly.askCardKeyAction('4', FIVE)];
check('a digit on the ALREADY-SELECTED option re-selects it — a double press is never a commit shortcut',
  twice.every(a => a.kind === 'select' && a.index === 3), JSON.stringify(twice));
check('the action vocabulary has NO commit variant at all — only ↵ (the owner’s accept) commits',
  !readFileSync('src/services/concourse/managerMode.ts', 'utf8').slice(0, 20_000).includes("kind: 'commit'") &&
    (['select', 'enough', 'ignore'] as const).every(k => readFileSync('src/services/concourse/managerMode.ts', 'utf8').includes(`kind: '${k}'`)));
check('the digit after the last option is the footer exit ("enough — plan it"); beyond it, digits are ignored',
  mgrEarly.askCardKeyAction('6', FIVE).kind === 'enough' &&
    mgrEarly.askCardKeyAction('7', FIVE).kind === 'ignore' &&
    mgrEarly.askCardKeyAction('0', FIVE).kind === 'ignore');
check('while the custom row is typing, digits are its text — never a select move',
  ['1', '5', '6'].every(d => mgrEarly.askCardKeyAction(d, { optionCount: 5, inInput: true }).kind === 'ignore'));
check('the card routes every digit through the one fold (askCardKeyAction) and never commits from it — the ONLY commit call is the owner’s onChange (↵)',
  cards.includes('askCardKeyAction(input, {') && (cards.match(/commit\(/g) ?? []).length === 1 &&
    cards.includes('const commit = ') && cards.includes('onChange={value => commit(String(value))}'),
  `commit( call sites: ${(cards.match(/commit\(/g) ?? []).length} (must be exactly one: the owner’s onChange)`);
check("the interview card turns the owner's digit-commit OFF (disableSelection 'numeric', indexes still painted)",
  cards.includes(`disableSelection="numeric"`) && !cards.includes('hideIndexes'));
check("the owner's machinery honours 'numeric' (its digit branch is fenced on it)",
  selectInput.includes(`disableSelection !== 'numeric'`));
check('the footer ordinal ("enough — plan it") is the one digit that FIRES — an exit, not an option',
  cards.includes('onEnough()') && cards.includes('enough — plan it'));
check('the controlled-focus mirror keeps every differing digit press a REAL re-assert',
  cards.includes('setFocusTarget(String(value))') && navigation.includes('}, [focusValue])'));
// Re-pinned: the localRow arithmetic picked the
// wrong option the moment any option wrapped; mouse parity now rides the
// Select's OWN per-option boxes (structural identity, focus-only — the
// select-never-commit law), so the card carries NO click arithmetic.
check('mouse parity rides the Select’s own option boxes (no localRow arithmetic in the card)',
  !/onClick=\{\(e: \{ localRow: number \}\)/.test(cards) &&
  /compact-vertical'\) \{[\s\S]{0,900}onClick=\{/.test(readFileSync('src/components/CustomSelect/select.tsx', 'utf8')));

// ── 3. 5-focuses-custom ─────────────────────────────────────────────────────
check('the custom option is the trailing INPUT row of the select',
  /type: 'input' as const,\s*\n\s*value: CUSTOM_VALUE/.test(cards));
// Re-cut: the card derives its ordinals from the options — custom = N+1,
// enough = N+2 — and the footer teaches the range it selects on.
check("the custom ordinal falls inside the card's select range (custom = options.length + 1; the footer teaches 1–N)",
  cards.includes('const customOrdinal = ask.options.length + 1') && cards.includes('1–${ask.options.length} select'));
check('the owner derives typing focus from the focused input option (isInInput)',
  navigation.includes('isInInput: isInputOption(focusedItem?.option)'));
check('an empty custom ↵ commits nothing (the card stays; no empty answer rides)',
  /if \(value === CUSTOM_VALUE\) \{[\s\S]{0,300}?if \(text\.length === 0\) return/.test(cards));

// ── 4. the one Yes: overload gate first, contracts beside dispatch, No = nothing ──
check('the Yes path gates on the PLAN demand BEFORE any dispatch op',
  /if \(snapshot\.counts\.live \+ plan\.lanes\.length > effectiveSeatCeiling\(\)\) \{\s*setManagerSeatAsk/.test(screen));
const noBranch = screen.slice(screen.indexOf('if (!yes) {'), screen.indexOf('const withSupervision'));
check('No/esc dispatches NOTHING and keeps the declined draft (POISON: a dispatch in the No branch)',
  noBranch.includes(`markManagerPlanState(entryId, { state: 'declined' })`) && !noBranch.includes('runManagerDispatch'));
check('declining the overload ask dispatches nothing (the plan card stays)',
  /answerManagerSeatAsk[\s\S]{0,400}?if \(!allowed\) \{\s*setNote[\s\S]{0,200}?return\s*\}\s*(?:\/\/[^\n]*\n\s*)*runManagerDispatch/.test(screen));

// CONTRACT BEFORE THE FIRST TURN (the lead's hold, to the letter): the
// dispatch door delivers the prompt AT ADMIT (the deliver seam), so a
// contract verb behind it lands on a lane whose first turn is already armed.
// A plan lane therefore starts EXACTLY as the ContractOfferCard's Yes leg
// starts a session — the birth door (sessionAdmit, bornBlank: no words
// sent) → the landed contract verb → the first turn delivered through the
// redirect leg (targetSessionId). POISON: a delivered first frame on a plan
// lane with no contract on the record = ANY sessionDispatch in the plan's op
// stream that carries a prompt WITHOUT targetSessionId (the admit-and-
// deliver form), or a delivery whose contract op does not precede it.
const mgr = await import('../../src/services/concourse/managerMode.js');
type Op = {
  op?: string;
  action?: string;
  bornBlank?: boolean;
  targetSessionId?: string;
  sessionId?: string;
  prompt?: string;
  contract?: { op?: string; text?: string };
  clientMessageId?: string;
};
const twoLanes = mgr.decodeManagerPlan({
  goal: 'ship the widget',
  lanes: [
    { title: 'lane A', scope: 'build the parser', deliverables: 'parser.ts green', territory: 'src/parser/**' },
    { title: 'lane B', scope: 'build the printer', deliverables: 'printer.ts green', territory: 'src/printer/**' },
  ],
  supervision: 'supervising',
  state: 'proposed',
})!;
check('a lawful two-lane plan decodes whole', twoLanes !== null && twoLanes.lanes.length === 2);
const noAdmitAndDeliver = (stream: readonly Op[]): boolean =>
  stream.every(o => o.op !== 'sessionDispatch' || (typeof o.targetSessionId === 'string' && o.targetSessionId.length > 0));
const contractPrecedesDelivery = (stream: readonly Op[]): boolean =>
  stream.every((o, i) =>
    o.op !== 'sessionDispatch' ||
    stream.slice(0, i).some(p => p.action === 'contract' && p.contract?.op === 'set' && p.sessionId === o.targetSessionId));
const makeRecorder = (stream: Op[], refuseSeatOnBirth = 0) => async (req: unknown): Promise<Record<string, unknown>> => {
  const r = req as Op;
  stream.push(r);
  if (r.op === 'sessionAdmit') {
    const births = stream.filter(o => o.op === 'sessionAdmit').length;
    if (births === refuseSeatOnBirth) return { ok: false, refusal: 'runtime-ceiling', error: 'no seat' };
    return { ok: true, sessionId: `sid-${births}`, runnerId: `r-${births}` };
  }
  if (r.op === 'sessionDispatch') return { ok: true, state: 'working' };
  return { ok: true, outcome: 'applied' };
};
const ops: Op[] = [];
const done = await mgr.executeManagerPlan(twoLanes, { workspaceRoot: '/tmp/x', by: 'coordinator-test', rpc: makeRecorder(ops) });
check('the one Yes runs birth(blank) → contract set → first turn delivered, PER LANE, through the three landed doors',
  ops.length === 6 &&
    ops[0]!.op === 'sessionAdmit' && ops[0]!.bornBlank === true &&
    ops[1]!.action === 'contract' && ops[1]!.contract?.op === 'set' && ops[1]!.sessionId === 'sid-1' &&
    ops[2]!.op === 'sessionDispatch' && ops[2]!.targetSessionId === 'sid-1' &&
    ops[3]!.op === 'sessionAdmit' && ops[4]!.action === 'contract' && ops[5]!.targetSessionId === 'sid-2',
  JSON.stringify(ops.map(o => o.action ?? o.op)));
check('POISON — no plan lane ever rides the admit-and-deliver form (every dispatch in the stream targets a born session)',
  noAdmitAndDeliver(ops));
check('POISON — every first-turn delivery is PRECEDED by a contract set on that very session (a delivered first frame with no contract on the record fails here)',
  contractPrecedesDelivery(ops));
check('the birth is the offer card’s own door (sessionAdmit + bornBlank — no words sent) and the verb is the landed one',
  readFileSync('src/services/switchboard/bornSession.ts', 'utf8').includes("op: 'sessionAdmit'") &&
    readFileSync('src/services/switchboard/bornSession.ts', 'utf8').includes('bornBlank: true') &&
    readFileSync('src/services/concourse/managerMode.ts', 'utf8').includes("op: 'sessionAdmit'") &&
    readFileSync('src/services/concourse/managerMode.ts', 'utf8').includes('bornBlank: true'));
check('the landed contract verb carries the draft agreement (set; scope + territory in its words)',
  (ops[1]!.contract?.text ?? '').includes('Scope: build the parser') &&
    (ops[1]!.contract?.text ?? '').includes('Territory: src/parser/**'));
check('the first turn is the lane brief — the agreement AND the sibling fences ride the first message too',
  (ops[2]!.prompt ?? '').includes('Your territory: src/parser/**') &&
    (ops[2]!.prompt ?? '').includes('"lane B" — src/printer/**') &&
    (ops[2]!.prompt ?? '').includes('Stay off their estate'));
check('lane session ids are recorded lane-ordered; nothing waits when everything fits',
  JSON.stringify(done.laneSessionIds) === JSON.stringify(['sid-1', 'sid-2']) && done.laneWaiting.length === 0);
check('every op settled as a visible receipt row (per lane: contract.set + session.launch)',
  done.receipts.length === 4 && done.receipts.every(r => r.outcome === 'applied'));
// Past the reading: what fits starts now, the rest WAIT in the plan — never
// a queued first frame (the birth door refuses instead of queueing).
const fitOps: Op[] = [];
const fitOne = await mgr.executeManagerPlan(twoLanes, { workspaceRoot: '/tmp/x', by: 'c', rpc: makeRecorder(fitOps), fits: 1 });
check('fits=1: lane 1 starts under its contract, lane 2 WAITS (no op of any kind for it)',
  fitOps.length === 3 && fitOne.laneSessionIds[0] === 'sid-1' && fitOne.laneSessionIds[1] === null &&
    JSON.stringify(fitOne.laneWaiting) === '[1]' && noAdmitAndDeliver(fitOps));
const ceilOps: Op[] = [];
const ceil = await mgr.executeManagerPlan(twoLanes, { workspaceRoot: '/tmp/x', by: 'c', rpc: makeRecorder(ceilOps, 1) });
check('a birth the daemon refuses for a seat joins the waiting set — no contract op, no delivery for that lane; the next lane still starts',
  ceil.laneSessionIds[0] === null && JSON.stringify(ceil.laneWaiting) === '[0]' &&
    ceil.laneSessionIds[1] === 'sid-2' && noAdmitAndDeliver(ceilOps) && contractPrecedesDelivery(ceilOps) &&
    ceilOps.filter(o => o.action === 'contract').length === 1);
// The start half: a waiting lane starts under its contract the beat a seat
// frees — the same three doors, one lane per beat; never while over.
mgr._resetManagerSupervisionForTesting();
mgr.registerDispatchedManagerPlan(
  { ...twoLanes, state: 'dispatched', laneSessionIds: ['sid-1', null], laneWaiting: [1] },
  { workspaceRoot: '/tmp/x' },
);
const laterOps: Op[] = [];
check('over the reading, the waiting lane stays waiting (no op)',
  (await mgr.startWaitingManagerLane({ live: 4, ceiling: 4 }, { rpc: makeRecorder(laterOps), by: 'c' })) === null && laterOps.length === 0);
const startedIdx = await mgr.startWaitingManagerLane({ live: 3, ceiling: 4 }, { rpc: makeRecorder(laterOps), by: 'c' });
check('a freed seat starts the waiting lane through birth(blank) → contract → first turn (the poisons hold on this path too)',
  startedIdx === 1 && laterOps.length === 3 && laterOps[0]!.op === 'sessionAdmit' && laterOps[0]!.bornBlank === true &&
    laterOps[1]!.action === 'contract' && laterOps[2]!.targetSessionId === 'sid-1' &&
    noAdmitAndDeliver(laterOps) && contractPrecedesDelivery(laterOps));
check('the register no longer holds a waiting lane afterwards',
  (await mgr.startWaitingManagerLane({ live: 0, ceiling: 4 }, { rpc: makeRecorder(laterOps), by: 'c' })) === null && laterOps.length === 3);
mgr._resetManagerSupervisionForTesting();
// THE REFUSED START (FN-017 rank 9): a waiting lane whose birth is refused
// for a reason OTHER than the seat carries its receipts out as a harness
// row keyed per lane, and the walker backs off — the base dropped the
// receipts (the plan card showed the lane waiting forever with no reason)
// and re-attempted the 30 s birth RPC on every board rebuild.
{
  const { mkdtempSync: mkScratch } = await import('node:fs');
  const { tmpdir: osTmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const convDir = mkScratch(joinPath(osTmp(), 'mgr-wait-'));
  mgr.registerDispatchedManagerPlan(
    { ...twoLanes, state: 'dispatched', laneSessionIds: ['sid-1', null], laneWaiting: [1] },
    { workspaceRoot: '/tmp/x', entryId: 'entry-refused' },
  );
  const refusedOps: Op[] = [];
  const refusingRpc = async (req: unknown): Promise<Record<string, unknown>> => {
    refusedOps.push(req as Op);
    return { ok: false, error: 'no repository at the workspace' };
  };
  const first = await mgr.startWaitingManagerLane({ live: 0, ceiling: 4 }, { rpc: refusingRpc, by: 'c' }, convDir);
  check('a non-seat refusal answers null after ONE birth attempt', first === null && refusedOps.filter(o => o.op === 'sessionAdmit').length === 1, JSON.stringify(refusedOps.map(o => o.op)));
  const conv = await import('../../src/services/concourse/coordinatorConversation.ts');
  const entries = await conv.readCoordinatorConversation(convDir);
  const waitRow = entries.find(e => e.id === 'mgr:wait:entry-refused:1');
  check("THE REFUSAL'S RECEIPTS REACH THE CONVERSATION as a harness row keyed per lane (the base threw them away)",
    waitRow !== undefined && waitRow.harness === true && (waitRow.receipts ?? []).some(r => r.outcome === 'refused' && /no repository/.test(r.label)),
    JSON.stringify(waitRow ?? entries.map(e => e.id)));
  const second = await mgr.startWaitingManagerLane({ live: 0, ceiling: 4 }, { rpc: refusingRpc, by: 'c' }, convDir);
  check('the walker BACKS OFF: an immediate rebuild does not re-attempt the birth (the base fired it every beat)', second === null && refusedOps.filter(o => o.op === 'sessionAdmit').length === 1);
  mgr._resetManagerSupervisionForTesting();
}
check('the plan executor never spells the admit-and-deliver form (source poison: a sessionDispatch with a prompt and no targetSessionId)',
  (() => {
    const src = readFileSync('src/services/concourse/managerMode.ts', 'utf8');
    const dispatchSites = src.split("op: 'sessionDispatch'").length - 1;
    const targeted = src.split('targetSessionId: sessionId').length - 1;
    return dispatchSites === 1 && targeted === 1;
  })());
check('the screen hands the executor the consented arithmetic (fits) — all lanes under the reading, ceiling − live past it',
  screen.includes('runManagerDispatch(entryId, withSupervision, plan.lanes.length)') &&
    screen.includes('runManagerDispatch(ask.entryId, ask.plan, Math.max(0, ask.ceiling - ask.live))'));
check('the existing snapshot beat drives the start half (no timers; one lane per beat)',
  screen.includes('m.startWaitingManagerLane(counts)'));

// ── 5. the harmony fields ───────────────────────────────────────────────────
check('a territory-less lane refuses WHOLE at decode (the harmony field is load-bearing)',
  mgr.decodeManagerPlan({ goal: 'g', lanes: [{ title: 't', scope: 's', deliverables: 'd' }] }) === null);
check('the plan card paints the territory fence per lane',
  cards.includes('territory: {lane.territory}'));
check('the addendum carries the harmony law + the T4 sufficiency standard, advisory grammar',
  mgr.MANAGER_MODE_ADDENDUM.includes('NON-OVERLAPPING') &&
    mgr.MANAGER_MODE_ADDENDUM.includes('ASK, naming') &&
    mgr.MANAGER_MODE_ADDENDUM.includes('CONTINUE') &&
    mgr.MANAGER_MODE_ADDENDUM.includes('TWO lanes by default'));
const collector: { ask?: unknown; plan?: unknown } = {};
const tools = mgr.managerToolSet(collector as never);
const askTool = tools.find(t => t.name === 'ask_operator')!;
const planTool = tools.find(t => t.name === 'propose_plan')!;
const ctxStub = {} as never;
const asked = JSON.parse((await askTool.run({ question: 'which stack?', options: ['bun', 'node'] }, ctxStub)).content) as { ok: boolean };
check('ask_operator lands the card in the collector (the interview is the model’s own conversation — no hardcoded questions anywhere)',
  asked.ok === true && collector.ask !== undefined && !readFileSync('src/services/concourse/managerMode.ts', 'utf8').includes('QUESTION_LIST'));
const second = JSON.parse((await askTool.run({ question: 'again?', options: ['a', 'b'] }, ctxStub)).content) as { ok: boolean };
check('one card per turn — a second card call refuses (SEQUENTIAL cards, never a batch screen)', second.ok === false);
// A FRESH turn's tool set: the one-card-per-turn law (a standing question
// card refuses every later card) would otherwise answer before the
// harmony-field check ever ran.
const planTurnTools = mgr.managerToolSet({} as never);
const freshPlanTool = planTurnTools.find(t => t.name === 'propose_plan')!;
const planRefused = JSON.parse(
  (await freshPlanTool.run({ goal: 'g', lanes: [{ title: 't', scope: 's', deliverables: 'd' }] }, ctxStub)).content,
) as { ok: boolean; refused?: string };
check('propose_plan refuses a territory-less lane, naming the harmony field',
  planRefused.ok === false && (planRefused.refused ?? '').includes('territory'), JSON.stringify(planRefused));
check('the ask decode caps proposed answers at 4 (5 is ALWAYS the card’s own custom input)',
  (mgr.decodeManagerAsk({ question: 'q', options: ['1', '2', '3', '4', '5'] })?.options.length ?? 0) === 4);

// ── 6. supervising-light on existing plumbing ───────────────────────────────
const owed = mgr.superviseLandEntries(
  [{ sessionId: 'a', title: 'lane A' }, { sessionId: 'b', title: 'lane B' }],
  [{ sessionId: 'a', state: 'ready-to-review' }, { sessionId: 'b', state: 'needs-you' }],
);
check('the pure fold owes ONE idempotent row per land/needs-you, stable ids',
  owed.length === 2 && owed[0]!.id === 'mgr:land:a' && owed[1]!.id === 'mgr:needs:b');
check('a working lane owes nothing (quiet while healthy)',
  mgr.superviseLandEntries([{ sessionId: 'a', title: 'A' }], [{ sessionId: 'a', state: 'working' }]).length === 0);
mgr._resetManagerSupervisionForTesting();
mgr.registerDispatchedManagerPlan({ ...twoLanes, state: 'dispatched', supervision: 'launch-only', laneSessionIds: ['a', 'b'] });
check('launch-only appends NOTHING (the calmer toggle)',
  (await mgr.appendManagerSupervisionRows([{ sessionId: 'a', state: 'completed' }])) === 0);
mgr._resetManagerSupervisionForTesting();
const mgrSource = readFileSync('src/services/concourse/managerMode.ts', 'utf8');
check('no watcher machinery of its own (no timers, no loops — the existing snapshot beat drives it)',
  !mgrSource.includes('setInterval') && !mgrSource.includes('setTimeout'));
check('the screen walker rides the EXISTING snapshot revision, reduced stage excluded',
  /useEffect\(\(\) => \{\s*if \(reducedStage\) return\s*const rows = sessionRows\.map[\s\S]{0,500}?appendManagerSupervisionRows/.test(screen));

// ── the send path + the card modality ───────────────────────────────────────
check('the manager send threads manager:true through the ONE conversation door',
  screen.includes('managerOnRef.current ? { manager: true } : undefined'));
check('the card owns keys only while the coordinator panel holds focus (the interview never imprisons the board) — the focus scoping is the ONE modal owner\'s own law',
  screen.includes('managerCardArmed: managerCardArmedRef.current,') &&
    screen.includes("coordinatorFocused: region === 'coordinator',") &&
    readFileSync('src/components/concourse/boardModalOwner.ts', 'utf8').includes("if (facts.managerCardArmed && facts.coordinatorFocused) return 'manager-card'"));
check('the manager seat ask is a consent modal while armed (the seat card law), yielding AFTER the tab block through the one owner',
  screen.includes('managerSeatAsk: managerSeatAskRef.current !== null,') &&
    screen.includes("if (modalOwner === 'manager-seat-ask' || modalOwner === 'manager-card') return"));

process.exit(fail);
