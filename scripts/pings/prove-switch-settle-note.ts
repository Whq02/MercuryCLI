import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


const scratch = mkdtempSync(join(tmpdir(), 'pings-note-'))
process.env.HOME = scratch
process.env.MERCURY_CONFIG_DIR = join(scratch, '.mercury')
mkdirSync(join(scratch, '.mercury'), { recursive: true })

const { publishSessionFacts, readSessionFacts } = await import(
  '../../src/engine/connector/seatProjections.js'
)
const { DaemonSessionConnector } = await import(
  '../../src/engine/connector/daemonConnector.js'
)
type SessionFactsV1 = import('../../src/engine/connector/seatProjections.js').SessionFactsV1

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

section('§1 a queued switch settling paints ONE grey note in THAT chat (the daemon\'s REAL publish order)')
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
check('no note stands while the switch is parked', noteRows(connector).length === 0, `rows=${noteRows(connector).length} — the facts read in src/engine/connector/daemonConnector.ts must mint a model_transition row only from a modelSettled stamp, never from a parked pendingModel`)
check(
  'the readout shows the parked switch (the drive observed state A)',
  connector.modelFacts().pendingSwitch?.setting === 'fable',
  `pendingSwitch=${JSON.stringify(connector.modelFacts().pendingSwitch)} — modelFacts in src/engine/connector/daemonConnector.ts must read pendingModel from the session facts published by publishSessionFacts`,
)

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
  check('the note is the applied turn-boundary receipt', row?.resolution === 'applied' && row?.boundary === 'turn-boundary', `row=${JSON.stringify(row)} — modelSettledRow in src/engine/connector/daemonConnector.ts must build the applied turn-boundary receipt`)
  check("the note names the settled model AS PICKED (the alias the label helper renders)", row?.applied === 'fable', `applied=${String(row?.applied)}`)
}

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

section('§2 once per stamp — a repeated settled publish mints no second row')
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

section('§3 a cancel (parked slot clears with NO stamp, model unchanged) mints nothing')
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
check('the readout shows the second park (the drive observed it)', parkedObserved, `pendingSwitch=${JSON.stringify(connector.modelFacts().pendingSwitch)} — modelFacts in src/engine/connector/daemonConnector.ts must follow the published pendingModel`)
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

section('§3b a fresh attach over a standing stamp adopts it silently (no replay on resume)')
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

section('§4 the ruled copy and the never-a-bell law (structural)')
{
  const onDisk = readFileSync(join(home, `${SID}.jsonl`), 'utf8')
  check(
    'the connector mints the note as a DISPLAY row (addDisplayRow — never a conversation write)',
    noteRows(connector).length === 1 && onDisk === '',
    `the painted records hold ${noteRows(connector).length} note row(s) and the transcript on disk ${onDisk.length} byte(s): the facts read mints the note as a display row of the connector and writes nothing of it to the conversation`,
  )
  publishSessionFacts(
    facts({
      effective: 'claude-fable-5',
      pendingModel: null,
      busy: false,
      atMs: 6000,
      modelSettled: { from: 'claude-opus-5', to: 'fable', atMs: 5900 },
    }),
  )
  const stampedAgain = await until(() => noteRows(connector).length === 2, 4000)
  check(
    "the edge reads the daemon's settlement stamp",
    stampedAgain,
    `rows=${noteRows(connector).length} after a second settlement of the same pair under a later stamp: the facts read mints one note per modelSettled.atMs, whatever models the stamp names`,
  )
  {
    const { openStatusPart } = await import('../ui/chatScenarios.ts')
    const { crossProviderNote, providerFamilyOfSetting } = await import('../../src/models/catalogue/modelTransition.ts')
    const { renderModelName } = await import('../../src/models/catalogue/engineModel.ts')
    const status = await openStatusPart('switch-settle-boundary', { keepHome: true })
    const settle = async (setting: string | null): Promise<string> => {
      status.notices.length = 0
      status.part.store().setState(prev => ({ ...prev, pendingModelSwitch: { setting } }))
      await status.plant({})
      await status.plant({})
      return status.notices.find(notice => notice.key === 'model-transition-applied')?.text ?? ''
    }
    const home = 'claude-opus-4-5'
    const sibling = 'claude-sonnet-4-5'
    const abroad = ['gpt-6.2-sol', 'gpt-6.1-sol', 'glm-4.6'].find(setting => providerFamilyOfSetting(setting) !== providerFamilyOfSetting(home) && crossProviderNote(setting) !== '') ?? ''
    const named = await settle(home)
    const within = await settle(sibling)
    const across = await settle(abroad)
    const byDefault = await settle(null)
    await status.close()
    check(
      'the boundary notification renders the label, Default included',
      named.startsWith(`${renderModelName(home)} applied — queued during the turn`) && byDefault.startsWith('Default applied — queued during the turn'),
      `${named} | ${byDefault} — the model-transition-applied notice in src/screen/chat/useChatStatus.tsx must render the model label, or Default when the setting is null`,
    )
    check(
      'the boundary notification carries the cross-provider note when the receipt says so',
      abroad !== '' && across === `${renderModelName(abroad)} applied — queued during the turn${crossProviderNote(abroad)}` && within === `${renderModelName(sibling)} applied — queued during the turn`,
      `${across} | ${within} — the model-transition-applied notice in src/screen/chat/useChatStatus.tsx must append crossProviderNote (src/models/catalogue/modelTransition.ts) only when the provider family changes`,
    )
  }
}

connector.detach()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL SWITCH-SETTLE-NOTE PROOFS PASS')
else console.log(`${failures} SWITCH-SETTLE-NOTE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
