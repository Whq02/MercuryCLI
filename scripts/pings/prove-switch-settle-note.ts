// ============================================================================
//  scripts/pings/prove-switch-settle-note.ts — the model-switched grey note
//  when a queued model switch settles, ONE display-only
//  row — "model switched to X for this session" — paints in THAT chat, never
//  in the model conversation, and the event never rings the bell.
//
//  The drive is the REAL seam end to end, headless: a DaemonSessionConnector
//  over a scratch config home; the daemon's own facts projection
//  (publishSessionFacts — the seat's publisher) carries a parked switch,
//  then its settlement, in the daemon's REAL publish order (FN-016 R15):
//  the idle-edge apply publishes pendingModel:null while the child's
//  LAGGING answer still names the old effective model, and the parked value
//  is the picked SETTING verbatim (an alias like 'fable'), so the retired
//  same-snapshot guard (next.model.effective === parked) could never fire —
//  the edge now drives off the daemon's own settlement receipt
//  (facts.modelSettled). Controls: a repeated settled publish mints no
//  second row (once per stamp); a cancel (the parked slot clearing with no
//  stamp) mints nothing; a FRESH attach over a standing stamp adopts it
//  silently (a resumed screen must not replay an old settle).
//
//  Structural pins: the ruled copy lives in the model_transition renderer
//  (with the cross-provider marker on the taken branch — FN-016 R17); the
//  boundary notification names the destination through the label helper
//  (FN-016 R16); the seat stamps the receipt at the idle-edge apply; the
//  connector path carries no bell write (the settle never pings — the ping
//  engine watches attention facts, and a settle mints none).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

// Scratch home BEFORE imports — no prover touches the real config home.
const scratch = mkdtempSync(join(tmpdir(), 'pings-note-'))
process.env.HOME = scratch
process.env.MERCURY_CONFIG_DIR = join(scratch, '.mercury')
mkdirSync(join(scratch, '.mercury'), { recursive: true })

const { publishSessionFacts, readSessionFacts } = await import(
  '../../src/services/engine-connector/seatProjections.js'
)
const { DaemonSessionConnector } = await import(
  '../../src/services/engine-connector/daemonConnector.js'
)
type SessionFactsV1 = import('../../src/services/engine-connector/seatProjections.js').SessionFactsV1

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failures += 1
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

const SID = '5b1e5f3a-1111-4222-8333-944445555666'
const home = join(scratch, 'project')
mkdirSync(home, { recursive: true })
writeFileSync(join(home, `${SID}.jsonl`), '')

function facts(over: {
  effective: string
  pendingModel: string | null
  busy: boolean
  atMs: number
  modelSettled?: { from: string; to: string; atMs: number }
}): SessionFactsV1 {
  return {
    schema: 1,
    sessionId: SID,
    atMs: over.atMs,
    pendingModel: over.pendingModel,
    busy: over.busy,
    ...(over.modelSettled !== undefined ? { modelSettled: over.modelSettled } : {}),
    model: { effective: over.effective, setting: over.effective },
    usage: {
      totalCostUSD: 0,
      totalAPIDurationMs: 0,
      totalDurationMs: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      hasUnknownModelCost: false,
    },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'default' as SessionFactsV1['permissionMode'],
    workspace: { cwd: home, originalCwd: home, projectRoot: home, instructionRoots: [] },
    queue: [],
  }
}

function noteRows(connector: InstanceType<typeof DaemonSessionConnector>) {
  return connector
    .records()
    .filter(
      m =>
        (m as { type?: string }).type === 'system' &&
        (m as { subtype?: string }).subtype === 'model_transition',
    ) as Array<{ applied?: string | null; resolution?: string; boundary?: string }>
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return pred()
}

//
section('§1 a queued switch settling paints ONE grey note in THAT chat (the daemon\'s REAL publish order)')
//
// The parked switch stands BEFORE the connector exists (the constructor's
// first facts read) — the mid-turn park, holding the picked SETTING
// verbatim (the alias 'fable', exactly what the picker rows carry).
// publishSessionFacts chains an ASYNC atomic publication, so every step
// waits for the state it needs to be OBSERVED before the next publish (the
// file first, then the connector's own readout) — the drive never races
// the publisher.
publishSessionFacts(facts({ effective: 'claude-opus-5', pendingModel: 'fable', busy: true, atMs: 1000 }))
const landedA = await until(() => readSessionFacts(SID)?.pendingModel === 'fable', 4000)
if (!landedA) {
  console.log('  ❌ rig: the parked-facts publication never landed')
  process.exit(1)
}
const connector = new DaemonSessionConnector({
  sessionId: SID,
  runnerId: 'w1',
  title: 'the proof chat',
  projectLabel: 'proof',
  workspaceId: home,
  home,
})
await connector.attach()
check('no note stands while the switch is parked', noteRows(connector).length === 0)
check(
  'the readout shows the parked switch (the drive observed state A)',
  connector.modelFacts().pendingSwitch?.setting === 'fable',
)

// PUBLISH A — the daemon's idle-edge apply: pendingModel clears and the
// settlement receipt is stamped, while the child's LAGGING answer still
// names the OLD effective model. The note is the daemon's own word: it
// paints NOW, from the stamp, not from the child's echo.
publishSessionFacts(
  facts({
    effective: 'claude-opus-5',
    pendingModel: null,
    busy: false,
    atMs: 2000,
    modelSettled: { from: 'claude-opus-5', to: 'fable', atMs: 1900 },
  }),
)
const painted = await until(() => noteRows(connector).length === 1, 4000)
check('the settle paints exactly one note row at PUBLISH A (the lagging-answer publish)', painted, `rows=${noteRows(connector).length}`)
{
  const row = noteRows(connector)[0]
  check('the note is the applied turn-boundary receipt', row?.resolution === 'applied' && row?.boundary === 'turn-boundary')
  check("the note names the settled model AS PICKED (the alias the label helper renders)", row?.applied === 'fable', `applied=${String(row?.applied)}`)
}

// PUBLISH B — the child re-answers with the resolved id: no second note.
publishSessionFacts(
  facts({
    effective: 'claude-fable-5',
    pendingModel: null,
    busy: false,
    atMs: 2500,
    modelSettled: { from: 'claude-opus-5', to: 'fable', atMs: 1900 },
  }),
)
await until(() => readSessionFacts(SID)?.atMs === 2500, 4000)
await new Promise(r => setTimeout(r, 500))
check("the child's catch-up answer mints no second row", noteRows(connector).length === 1, `rows=${noteRows(connector).length}`)

//
section('§2 once per stamp — a repeated settled publish mints no second row')
//
publishSessionFacts(
  facts({
    effective: 'claude-fable-5',
    pendingModel: null,
    busy: false,
    atMs: 3000,
    modelSettled: { from: 'claude-opus-5', to: 'fable', atMs: 1900 },
  }),
)
await until(() => readSessionFacts(SID)?.atMs === 3000, 4000)
await new Promise(r => setTimeout(r, 900))
check('still exactly one note row', noteRows(connector).length === 1, `rows=${noteRows(connector).length}`)

//
section('§3 a cancel (parked slot clears with NO stamp, model unchanged) mints nothing')
//
publishSessionFacts(
  facts({
    effective: 'claude-fable-5',
    pendingModel: 'glm-5.2',
    busy: true,
    atMs: 4000,
    modelSettled: { from: 'claude-opus-5', to: 'fable', atMs: 1900 },
  }),
)
const parkedObserved = await until(() => connector.modelFacts().pendingSwitch?.setting === 'glm-5.2', 4000)
check('the readout shows the second park (the drive observed it)', parkedObserved)
publishSessionFacts(
  facts({
    effective: 'claude-fable-5',
    pendingModel: null,
    busy: false,
    atMs: 5000,
    modelSettled: { from: 'claude-opus-5', to: 'fable', atMs: 1900 },
  }),
)
await until(() => connector.modelFacts().pendingSwitch === null, 4000)
await new Promise(r => setTimeout(r, 500))
check('the cancelled park mints no note', noteRows(connector).length === 1, `rows=${noteRows(connector).length}`)

//
section('§3b a fresh attach over a standing stamp adopts it silently (no replay on resume)')
//
{
  const resumed = new DaemonSessionConnector({
    sessionId: SID,
    runnerId: 'w1',
    title: 'the resumed chat',
    projectLabel: 'proof',
    workspaceId: home,
    home,
  })
  await resumed.attach()
  await new Promise(r => setTimeout(r, 600))
  check('the resumed screen mints NO note from the old stamp', noteRows(resumed).length === 0, `rows=${noteRows(resumed).length}`)
  resumed.detach()
}

//
section('§4 the ruled copy and the never-a-bell law (structural)')
//
{
  const renderer = readFileSync(join(ROOT, 'src', 'components', 'messages', 'SystemTextMessage.tsx'), 'utf8')
  check(
    "the renderer speaks the ruled sentence ('model switched to … for this session')",
    renderer.includes('model switched to') && renderer.includes('for\n            this session'),
  )
  // FN-016 R17: the turn-boundary row carries the cross-provider marker on
  // the branch the producer actually takes — through the ONE note owner,
  // never a hand-rolled variant.
  check(
    'the turn-boundary row shows the cross-provider note (the one owner)',
    /for\n            this session[\s\S]{0,120}?crossProviderNote\(message\.applied\)/.test(renderer),
  )
  const connectorSrc = readFileSync(
    join(ROOT, 'src', 'services', 'engine-connector', 'daemonConnector.ts'),
    'utf8',
  )
  check(
    'the connector mints the note as a DISPLAY row (addDisplayRow — never a conversation write)',
    /createModelTransitionMessage\(/.test(connectorSrc) &&
      /addDisplayRow\(\s*createModelTransitionMessage\(/.test(connectorSrc.replace(/\n\s+/g, ' ').replace(/\( /g, '(')) ||
      connectorSrc.includes('this.addDisplayRow('),
  )
  // FN-016 R15: the edge drives off the daemon's own settlement receipt —
  // never the retired same-snapshot coincidence test.
  check(
    "the edge reads the daemon's settlement stamp",
    connectorSrc.includes('next.modelSettled') && connectorSrc.includes('prev.modelSettled?.atMs'),
  )
  check(
    'the retired coincidence guard is gone',
    !connectorSrc.includes('next.model.effective === parked'),
  )
  check(
    'the connector rings no bell (no BEL, no termWrite, no notifyBell anywhere in it)',
    !connectorSrc.includes('BEL') && !connectorSrc.includes('termWrite') && !connectorSrc.includes('notifyBell'),
  )
  const seatSrc = readFileSync(join(ROOT, 'src', 'daemon', 'sessionSeat.ts'), 'utf8')
  check(
    'the seat STAMPS the receipt where the idle edge applies the parked switch',
    seatSrc.includes('parkedSettle: true') && seatSrc.includes('lastModelSettle = {'),
  )
  check(
    'the publisher carries the stamp on every facts publish',
    /modelSettled: seat\.lastModelSettle/.test(seatSrc),
  )
  // FN-016 R16: the boundary notification names the destination through
  // the label helper (never the raw setting id, never the bare word
  // 'model' for the Default row) — and rides the cross-provider note on
  // the same line (R17).
  const replSrc = readFileSync(join(ROOT, 'src', 'screens', 'REPL.tsx'), 'utf8')
  check(
    'the boundary notification renders the label, Default included',
    /applied === null \? 'Default' : renderModelName\(applied\)/.test(replSrc),
  )
  check(
    'the boundary notification carries the cross-provider note when the receipt says so',
    /receipt\.crossProvider \? crossProviderNote\(/.test(replSrc),
  )
  // FN-016 R17: both /model command surfaces append the note on their
  // DAEMON branches — the branches a daemon-hosted chat actually takes.
  const wrapperSrc = readFileSync(join(ROOT, 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf8')
  check(
    "the picker wrapper's daemon branch carries the note",
    /const doorCross = [\s\S]{0,200}?crossProviderNote\(value\)/.test(wrapperSrc) && wrapperSrc.includes('${doorCross}'),
  )
  const modelCmdSrc = readFileSync(join(ROOT, 'src', 'commands', 'model', 'model.tsx'), 'utf8')
  check(
    "the /model command's daemon branch carries the note",
    /const doorCross =[\s\S]{0,240}?crossProviderNote\(target\)/.test(modelCmdSrc) && modelCmdSrc.includes('${doorCross}'),
  )
  // The composer's own daemon arm (the rank-23 carrier) is the THIRD
  // surface: it reads the from-model BEFORE the door applies — the
  // connector's facts already name the destination on an applied receipt,
  // so a preview taken after compared the destination with itself (an
  // always-empty loss note) — and rides the same cross-provider note.
  const composerSrc = readFileSync(join(ROOT, 'src', 'components', 'PromptInput', 'PromptInput.tsx'), 'utf8')
  check(
    "the composer's daemon arm reads the from-model before the door",
    /const effectiveBefore = focused\.modelFacts\(\)\.effective\s*\n\s*const receipt = focused\.setModel\(value\)/.test(composerSrc),
  )
  check(
    "…previews loss against THAT model and carries the note",
    composerSrc.includes('previewForSelection(messages, effectiveBefore, value)') &&
      /const doorCross = providerFamilyOfSetting\(effectiveBefore\) !== providerFamilyOfSetting\(value\) \? crossProviderNote\(value\) : ''/.test(composerSrc) &&
      (composerSrc.match(/\$\{doorCross\}\$\{doorLossNote\}/g) ?? []).length === 2,
  )
  check(
    "the picker wrapper's daemon branch previews loss against its before-the-door fact too",
    wrapperSrc.includes('previewForSelection(messages, factsBefore.effective, value)') &&
      !wrapperSrc.includes('previewForSelection(messages, focused.modelFacts().effective, value)'),
  )
}

connector.detach()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL SWITCH-SETTLE-NOTE PROOFS PASS')
else console.log(`${failures} SWITCH-SETTLE-NOTE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
