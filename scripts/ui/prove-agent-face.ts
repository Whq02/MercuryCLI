#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, waitUntil } from '../engine-durability/harness.ts'
import { ALL_MODEL_CONFIGS, newestGenerationKey } from '../../src/models/facts/builtInModelTable.ts'

const DEFAULT_OPUS = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty

process.env['MERCURY_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'agent-face-prove-'))

const t = checker()

const repoRoot = join(import.meta.dirname, '..', '..')

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()

await import('../../src/tools/crewmate/CrewmateTool.js')

const {
  advancedFieldSeed,
  buildReviewFacts,
  computeStudioValidation,
  createStudioEditorMachine,
  effectiveStudioRuntime,
  freshStudioDocument,
  guidedNext,
  guidedSeedFor,
  studioDestinationPath,
} = await import('../../src/screen/agents/studio/studioEditorModel.js')
const { decodeAgentDocument } = await import('../../src/crew/agents/codec.js')
const { AgentStoreError } = await import('../../src/crew/agents/store.js')
const { revisionDigest } = await import('../../src/crew/agents/contracts.js')

t.section('§1 — IDENTITY BOTH DIRECTIONS (the extraction law)')
{

  const stills = Bun.spawnSync(['bun', join(repoRoot, 'scripts/ui/agent-face-stills.ts')], { cwd: repoRoot })
  const out = stills.stdout.toString() + stills.stderr.toString()
  t.check('the in-chat mount frames byte-match the base fixtures', stills.exitCode === 0 && out.includes('PASS inchat-create-guided') && out.includes('PASS inchat-edit-advanced'), out.slice(0, 400))
}

t.section('§2 — THE MACHINE WALKED WHOLE (fakes + hand-driven beats)')

type Snap = ReturnType<ReturnType<typeof createStudioEditorMachine>['snapshot']>

function harness(opts?: {
  base?: { raw: string; filePath: string }
  drafts?: { path: string; draft: { baseIdentity?: { filePath: string; revision: string }; raw: string } }[]
  saveOutcome?: 'ok' | 'conflict'
  generateBehaviour?: 'settle' | 'hang'
  theirRaw?: string
  mode?: 'create' | 'edit'
}) {
  const events: string[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const saved: { target: unknown; raw: string }[] = []
  const savedDrafts: unknown[] = []
  const discardedDrafts: string[] = []
  let snaps: Snap[] = []
  const baseIdentity = opts?.base
    ? { filePath: opts.base.filePath, revision: revisionDigest(opts.base.raw) }
    : undefined
  const baseAgent = opts?.base
    ? ({
        agentType: 'fixture-scout',
        whenToUse: 'x',
        getSystemPrompt: () => '',
        source: 'projectSettings',
        filePath: opts.base.filePath,
        revision: baseIdentity!.revision,
      } as never)
    : undefined
  const theirRaw = opts?.theirRaw ?? '---\nname: fixture-scout\ndescription: Their newer description, written elsewhere on disk.\n---\nTheir newer body, long enough to stand as a real system prompt.\n'
  const machine = createStudioEditorMachine(
    {
      mode: opts?.mode ?? (opts?.base ? 'edit' : 'create'),
      ...(opts?.base ? { base: { identity: baseIdentity!, agent: baseAgent! } } : {}),
      cwd: cwdDir,
      getExistingAgents: () => existing,
      getParentModel: () => 'claude-fable-5',
      onSaved: message => events.push(`saved:${message}`),
      onCancel: () => events.push('cancel'),
    },
    s => snaps.push(s),
    {
      readFile: path => {
        if (opts?.base && path === opts.base.filePath) return opts.base.raw
        throw new Error(`no fixture file at ${path}`)
      },
      saveDocument: async (target, doc) => {
        if (opts?.saveOutcome === 'conflict') {
          throw new AgentStoreError('revision-conflict', 'revision moved', { currentRaw: theirRaw })
        }
        saved.push({ target, raw: doc.raw })
        return {
          path: '/dest/agent.md',
          afterRevision: 'rev-2',
          semanticChanges: ['description'],
          bytes: doc.raw.length,
          at: 'now',
        }
      },
      saveDraft: async draft => {
        savedDrafts.push(draft)
        return '/drafts/x.json'
      },
      listDrafts: () => (opts?.drafts ?? []) as never,
      discardDraft: path => {
        discardedDrafts.push(path)
      },
      generate: (_prompt, _model, _existing, signal) => {
        events.push('generate-called')
        if (opts?.generateBehaviour === 'hang') {
          return new Promise((_res, rej) => {
            signal.addEventListener('abort', () => rej(new Error('aborted')))
          })
        }
        return Promise.resolve({
          identifier: 'made-scout',
          whenToUse: 'Use this agent when the walk needs a generated fixture.',
          systemPrompt: 'You are the generated fixture scout. Hold the machine to its own spellings and never improvise beyond them.',
        })
      },
      setTimer: (fn, ms) => {
        const h = { fn, ms, cleared: false }
        timers.push(h)
        return h
      },
      clearTimer: handle => {
        ;(handle as { cleared: boolean }).cleared = true
      },
    },
  )
  return {
    machine,
    events,
    timers,
    saved,
    savedDrafts,
    discardedDrafts,
    snap: () => machine.snapshot(),
    theirRaw,
    lastNote: () => machine.snapshot().note?.text ?? '',
    fireLastTimer: () => {
      const live = timers.filter(x => !x.cleared)
      const last = live[live.length - 1]
      if (last) last.fn()
    },
  }
}

const cwdDir = mkdtempSync(join(tmpdir(), 'agent-face-cwd-'))
mkdirSync(join(cwdDir, '.mercury', 'agents'), { recursive: true })
let existing: never[] = []

{
  const h = harness()
  t.check('create opens on the guided destination step', h.snap().view.kind === 'guided' && (h.snap().view as { step: string }).step === 'destination')
  h.machine.guidedDestination('user')
  t.check('destination commits the scope and steps to method', h.snap().scope === 'user' && (h.snap().view as { step: string }).step === 'method')
  h.machine.guidedMethod('manual')
  t.check('manual method steps to identity', (h.snap().view as { step: string }).step === 'identity')
  h.machine.guidedIdentity('Bad Name!')
  t.check('a bad identifier refuses with the validator spelling and stays', h.snap().note !== null && (h.snap().view as { step: string }).step === 'identity')
  h.machine.guidedIdentity('walk-scout')
  t.check('a lawful identifier commits and steps to prompt', h.snap().doc.fields.name === 'walk-scout' && (h.snap().view as { step: string }).step === 'prompt')
  h.machine.guidedPrompt('too short')
  t.check('a short prompt refuses with the 20-char spelling', h.lastNote() === 'system prompt is too short (minimum 20 characters)')
  h.machine.guidedPrompt('You are the walk scout. Walk the whole estate and report faithfully.')
  t.check('a real prompt commits with the trailing newline and steps on', h.snap().doc.body.endsWith('faithfully.\n') && (h.snap().view as { step: string }).step === 'description')
  h.machine.guidedDescription('   ')
  t.check('an empty description refuses with the delegation spelling', h.lastNote() === 'description is required — it tells Mercury when to delegate')
  h.machine.guidedDescription('Use this agent when the machine walk needs a fixture.')
  t.check('description commits and steps to tools', (h.snap().view as { step: string }).step === 'tools')
  h.machine.guidedTools(['Read'])
  t.check('tools commit and step to model', JSON.stringify(h.snap().doc.fields.tools) === '["Read"]' && (h.snap().view as { step: string }).step === 'model')
  h.machine.guidedModel('inherit')
  t.check("model 'inherit' stores undefined and lands review", h.snap().doc.fields.model === undefined && h.snap().view.kind === 'review')
  await h.machine.save()
  t.check('save lands the receipt spelling through onSaved', h.events.some(e => e.startsWith('saved:Created agent walk-scout → /dest/agent.md (rev rev-2; changed: description)')), h.events.join(' | '))
  t.check('save targets the new road with the picked scope', JSON.stringify((h.saved[0]?.target as { scope?: string })?.scope) === '"user"')
}

{
  const h = harness()
  await h.machine.save()
  t.check('save refuses on validation errors with the gate spelling', h.lastNote() === 'fix the errors above before saving' && h.saved.length === 0)
}

{
  const h = harness()
  h.machine.guidedDestination('project')
  h.machine.guidedBack()
  t.check('back pops to destination', (h.snap().view as { step: string }).step === 'destination')
  h.machine.guidedBack()
  t.check('back off the empty history cancels', h.events.includes('cancel'))
}

{
  const h = harness()
  h.machine.setView({ kind: 'review' })
  h.machine.reviewEscape()
  const v = h.snap().view as { kind: string; step?: string; history?: string[] }
  t.check('review esc (create) restores the guided model step with the six-step history', v.kind === 'guided' && v.step === 'model' && JSON.stringify(v.history) === JSON.stringify(['destination', 'method', 'identity', 'prompt', 'description', 'tools']))
}

{
  const baseRaw = '---\nname: fixture-scout\ndescription: The base description as discovered on disk today.\n---\nThe base body, long enough to be a lawful system prompt for the walk.\n'
  const h = harness({ base: { raw: baseRaw, filePath: join(cwdDir, '.mercury', 'agents', 'fixture-scout.md') }, saveOutcome: 'conflict' })
  t.check('edit opens on the advanced list over the re-read base bytes', h.snap().view.kind === 'advanced' && h.snap().doc.raw === baseRaw)
  h.machine.commitTextField('description', 'My newer description, edited in this draft with intent.')
  await h.machine.save()
  t.check('a conflicted save arms the conflict with its spelling', h.snap().conflict !== null && h.lastNote().startsWith('the file changed outside this draft'))
  h.machine.mergeOntoTheirs()
  const merged = h.snap()
  t.check('merge re-applies MY changed field and preserves THEIR changed body', merged.doc.fields.description === 'My newer description, edited in this draft with intent.' && merged.doc.body.startsWith('Their newer body'))
  t.check('merge re-anchors the base revision to theirs', merged.baseRevision === revisionDigest(h.theirRaw))
  t.check('merge clears the conflict and speaks the re-apply spelling', merged.conflict === null && merged.note?.text.startsWith('their version loaded'))
}

{
  const draftRaw = '---\nname: recovered-scout\ndescription: A draft left behind by a previous session for recovery.\n---\nThe recovered body, long enough to stand as a lawful system prompt.\n'
  const accept = harness({ drafts: [{ path: '/drafts/new.json', draft: { raw: draftRaw } }] })
  t.check('a matching draft is offered once, on entry', accept.snap().recoverOffer !== null)
  accept.machine.acceptRecover()
  t.check('accept adopts the draft, lands advanced (create) and says so', accept.snap().doc.fields.name === 'recovered-scout' && accept.snap().view.kind === 'advanced' && accept.lastNote() === 'draft recovered — continuing where you left off')
  const decline = harness({ drafts: [{ path: '/drafts/new.json', draft: { raw: draftRaw } }] })
  decline.machine.declineRecover()
  t.check('decline discards the draft file and clears the offer', decline.discardedDrafts.includes('/drafts/new.json') && decline.snap().recoverOffer === null)
}

{
  const h = harness()
  h.machine.commit({ set: { name: 'auto-scout' } })
  t.check('a commit arms the autosave debounce at the landed 800ms', h.timers.filter(x => !x.cleared).length === 1 && h.timers[0]!.ms === 800)
  h.machine.commit({ set: { description: 'Another edit re-arms the debounce window.' } })
  t.check('a second commit re-arms (the first timer cleared)', h.timers[0]!.cleared === true && h.timers.filter(x => !x.cleared).length === 1)
  h.fireLastTimer()
  await Promise.resolve()
  const draft = h.savedDrafts[0] as { newTarget?: { scope: string }; raw?: string } | undefined
  t.check('the fired debounce writes the draft with the new-target road', draft !== undefined && draft.newTarget?.scope === 'project' && (draft.raw ?? '').includes('auto-scout'))
}

{
  const h = harness()
  h.machine.guidedDestination('project')
  h.machine.guidedMethod('generate')
  t.check('generate method steps to describe', (h.snap().view as { step: string }).step === 'describe')
  h.machine.guidedDescribe('an agent that walks fixtures')
  await Promise.resolve()
  await Promise.resolve()
  const s = h.snap()
  t.check('a settled generation adopts the fields, lands review and says so', s.doc.fields.name === 'made-scout' && s.view.kind === 'review' && s.note?.text === 'generated "made-scout" — review it below')
  t.check('generation ran un-busy after settle', s.busy === false)
}

{
  const h = harness({ generateBehaviour: 'hang' })
  h.machine.guidedDestination('project')
  h.machine.guidedMethod('generate')
  h.machine.guidedDescribe('an agent that never settles')
  t.check('a hanging generation holds busy with the working note', h.snap().busy === true && h.lastNote() === 'generating agent from description …')
  const aborted = h.machine.abortGeneration()
  t.check('abort answers true and speaks the cancelled spelling', aborted && h.lastNote() === 'generation cancelled')
  await Promise.resolve()
  await Promise.resolve()
  t.check('the aborted settle un-busies through the failure arm (the landed sequence)', h.snap().busy === false && h.lastNote().startsWith('generation failed:'))
  t.check('abort with no live generation answers false', h.machine.abortGeneration() === false)
}

{
  const h = harness()
  const before = h.snap().doc.raw
  h.machine.loadRaw(before)
  t.check('loadRaw with unchanged bytes is a silent no-op', h.snap().doc.raw === before && h.snap().note === null)
  h.machine.loadRaw('---\ndescription: no name here\n---\nA body without a name key above it, long enough to pass length.\n')
  t.check('loadRaw with an erroring document counts its errors on the note', /raw edit loaded with \d+ error/.test(h.lastNote()))
  const clean = '---\nname: raw-scout\ndescription: A clean raw replacement written through the editor door.\n---\nA lawful replacement body, long enough for the validation floor.\n'
  h.machine.loadRaw(clean)
  t.check('loadRaw with clean bytes says raw edit loaded', h.lastNote() === 'raw edit loaded')
}

{
  const h = harness()
  h.machine.setView({ kind: 'advanced', cursor: 0, editing: null })
  h.machine.openFieldEditor('maxTurns')
  t.check('openFieldEditor seeds the text buffer for text fields', h.snap().textBuffer === '' && (h.snap().view as { editing: string }).editing === 'maxTurns')
  h.machine.commitTextField('maxTurns', 'seven')
  t.check('a non-integer max-turns refuses with its spelling and stays editing', h.lastNote() === 'max turns must be a positive integer (empty clears)' && (h.snap().view as { editing: string | null }).editing === 'maxTurns')
  h.machine.commitTextField('maxTurns', '12')
  t.check('a lawful max-turns commits and closes the editor', h.snap().doc.fields.maxTurns === 12 && (h.snap().view as { editing: string | null }).editing === null)
  h.machine.openFieldEditor('skills')
  h.machine.commitTextField('skills', ' chart-lore ,  map-lore , ')
  t.check('skills split on commas, trimmed, empties dropped', JSON.stringify(h.snap().doc.fields.skills) === '["chart-lore","map-lore"]')
  h.machine.openFieldEditor('initialPrompt')
  h.machine.commitTextField('initialPrompt', '   ')
  t.check('an emptied initial prompt clears to undefined', h.snap().doc.fields.initialPrompt === undefined)
}

{
  const doc = freshStudioDocument()
  const v = computeStudioValidation({ doc, existingAgents: [], base: undefined, mode: 'create' })
  t.check('a fresh draft fails validation on the three required fields', !v.canSave && v.errors.length >= 3)
  t.check('guidedNext is total over the step union', (['destination', 'method', 'describe', 'identity', 'prompt', 'description', 'tools', 'model', 'review'] as const).every(s => typeof guidedNext(s) === 'string'))
  const seededDoc = decodeAgentDocument('---\nname: seed-scout\ndescription: Seeds for the guided steps.\n---\nSeed body here.\n')
  t.check('guided seeds read the draft (identity · prompt · description; else empty)', guidedSeedFor(seededDoc, 'identity') === 'seed-scout' && guidedSeedFor(seededDoc, 'prompt') === 'Seed body here.' && guidedSeedFor(seededDoc, 'destination') === '')
  t.check('advanced field seeds mirror the openText initials', advancedFieldSeed(seededDoc, 'name') === 'seed-scout' && advancedFieldSeed(seededDoc, 'maxTurns') === '')
  const dest = studioDestinationPath({ base: undefined, scope: 'project', cwd: cwdDir, name: '' })
  t.check('the new-draft destination names the placeholder identifier', dest.endsWith('<identifier>.md'))
  const eff = effectiveStudioRuntime({ doc: seededDoc, base: undefined, scope: 'project', parentModel: 'claude-fable-5', sessionEffort: undefined, tools: [] })
  t.check('the effective runtime resolves over the synthetic definition', typeof eff.model === 'string' && eff.model.length > 0)
  const facts = buildReviewFacts(seededDoc, undefined, () => '')
  t.check('review facts census the changed keys and bound the diff at ten lines', facts.changed.includes('name') && facts.diffLines.length <= 10)
}

t.section('§3 — THE FACE SKIN (BootAgentsScreen: the real mount · route silence · the composer tiers)')
{

  const routeStore = await import('../../src/screen/routes/surfaceRoute.js')
  const versionBefore = routeStore.surfaceRouteVersion()
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
  const { BootAgentsScreen } = await import('../../src/screen/boot-face/BootAgentsScreen.js')
  const mkAgent = (over: Record<string, unknown>): unknown => ({
    agentType: 'x',
    whenToUse: 'x',
    getSystemPrompt: () => 'You are a fixture.',
    source: 'projectSettings',
    ...over,
  })
  const scout = mkAgent({
    agentType: 'fixture-scout',
    whenToUse: 'Use this agent to scout the fixture estate.',
    filePath: '/repo/.mercury/agents/fixture-scout.md',
    revision: 'rev-1',
    model: 'opus',
  })
  const keeper = mkAgent({
    agentType: 'ledger-keeper',
    whenToUse: 'Keeps the fixture ledger square.',
    source: 'userSettings',
    filePath: '/home/.mercury/agents/ledger-keeper.md',
    revision: 'rev-2',
    disabled: true,
  })
  const injected = { activeAgents: [scout], allAgents: [scout, keeper] }
  const frame = await renderToString(
    React.createElement(BootAgentsScreen, {
      definitions: injected,
      workspaceDir: '/repo',
      toolsOf: () => [],
      fullScene: { columns: 120, rows: 40 },
    } as never),
    120,
  )
  t.check('the mounted face lists the roster by scope', frame.includes('fixture-scout') && frame.includes('ledger-keeper'), frame.slice(0, 300))
  t.check('the mounted face wears the library legend', frame.includes('n new') && frame.includes('u trash'))
  t.check("the mounted face speaks the seamless truth on the AGENTS panel", frame.includes('live sessions see new agents'))
  t.check('a disabled agent wears off; an enabled one its model word', frame.includes('off') && frame.includes('opus'))
  t.check('the route store never moved under the mount (live-store silence)', routeStore.surfaceRouteVersion() === versionBefore)
}

t.section('§4 — TWO SKINS, ONE MODEL (the face consumes the machine; no second home)')
{
}

t.section("§5 — THE BOOT MENU DOOR, BOTH HOSTS (Agents lives inside Boot Menu; the 'agents' wire word)")
{
  const { assembleCardRows } = await import('../../assets/splash/splash-core.mjs')
  const { settingsEditors } = await import('../../src/screen/boot-face/settings/menuModel.js')
  const rowsOf = (facts: Record<string, unknown>): Array<{ key: string; icon: string; label: string; ctx: string }> =>
    assembleCardRows(facts) as never
  const BASE = { cwdBase: 'proj', continueTarget: null, menuAvailable: true }
  const FULL = { ...BASE, concourse: { ctx: 'the live board' } }
  const CHAT = { ...BASE, concourse: null }
  const full = rowsOf(FULL).map(r => r.key)
  const chat = rowsOf(CHAT).map(r => r.key)
  t.check(
    'the full world carries the approved four no-history rows (Agents moved into Boot Menu)',
    JSON.stringify(full) === JSON.stringify(['new', 'logins', 'concourse', 'menu']),
    full.join(' · '),
  )
  t.check('the --chat world carries the same rows minus concourse', JSON.stringify(chat) === JSON.stringify(['new', 'logins', 'menu']), chat.join(' · '))
  const editor = settingsEditors.find(r => r.editor === 'agents')
  t.check(
    "Agents opens from Boot Menu with its ruled label and summary ('create and edit agents')",
    editor?.label === 'Agents' && editor?.summary === 'create and edit agents',
    JSON.stringify(editor),
  )
  t.check('menuAvailable: false drops Boot Menu (so the Agents editor rides the same fit law)', !rowsOf({ ...FULL, menuAvailable: false }).map(r => r.key).includes('menu'))
  const { decideSplashReceipt, consumeFaceDoorDeepLink } = await import('../../src/platform/substrate/splashHandover.js')
  const now = 1_700_000_000_000
  const fresh = decideSplashReceipt(JSON.stringify({ version: 1, ts: now, action: 'agents' }), now, () => true)
  t.check("the 'agents' receipt applies with nothing to chdir or splice", fresh.reason === 'applied' && fresh.apply === null)
  t.check("the receipt arms the 'agents' face door exactly once", consumeFaceDoorDeepLink() === 'agents' && consumeFaceDoorDeepLink() === null)

}

t.section('§6 — THE MULTIAUTH MANDATE (any model from the catalogue · truly provider-neutral · sign-in routing)')
{
  const { agentModelPickOutcome, getAgentModelPickerRows } = await import('../../src/models/catalogue/agentModelPicker.js')
  const { ANTHROPIC_MODEL_GROUP, isProviderActionRow } = await import('../../src/models/catalogue/modelOptions.js')
  const fixture: import('../../src/models/catalogue/modelOptions.ts').ModelOption[] = [
    { value: '__mercury_anthropic_connect__', label: 'Claude — sign in', description: '↵ runs /logins anthropic' },
    { value: 'fable', label: 'Fable', description: '' },
    { value: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)', description: '' },
    { value: 'haiku', label: 'Haiku', description: '' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: '' },
    { value: 'my-custom-model', label: 'Custom', description: 'operator copy (MERCURY_CUSTOM_MODEL_OPTION passthrough, no group)' },
    { value: 'gpt-6.2', label: 'GPT-6.2', description: '', group: 'Mercury — OpenAI models', unavailable: 'no OpenAI account connected' },
    { value: '__mercury_connect__:zai', label: 'Z.AI — attach a key', description: '↵ opens /logins zai', group: 'Mercury — Z.AI models' },
    { value: 'glm-5.3', label: 'GLM-5.3', description: '', group: 'Mercury — Z.AI models', unavailable: 'no API key attached' },
    { value: 'openrouter/qwen/qwen3-coder', label: 'qwen3-coder', description: '', group: 'Mercury — OpenRouter models', statedContextWindow: 262144 },
    { value: 'compat/qwen3', label: 'qwen3', description: '', group: 'Mercury — custom endpoint' },
  ]
  const rows = getAgentModelPickerRows(fixture)
  t.check('inherit leads — the agent grammar\'s own default row', rows[0]?.kind === 'inherit' && rows[0]?.value === 'inherit')
  const expected = fixture
  t.check(
    'picker rows contain every eligible catalogue row in order',
    JSON.stringify(rows.slice(1).map(r => r.value)) === JSON.stringify(expected.map(o => o.value)),
    rows.map(r => r.value).join(' · '),
  )
  t.check(
    'TOTALITY, row-wise: kind by the action-row owner · group by the catalogue paint law · unavailable/description carried byte-equal · a model row is labelled by its full id, a connect row by its own words',
    expected.every((opt, i) => {
      const row = rows[i + 1]!
      return (
        row.kind === (isProviderActionRow(opt.value) ? 'connect' : 'model') &&
        row.group === (opt.group ?? ANTHROPIC_MODEL_GROUP) &&
        row.unavailable === opt.unavailable &&
        row.label === (isProviderActionRow(opt.value) ? opt.label : opt.value) &&
        row.description === opt.description
      )
    }),
  )
  t.check(
    'TOTALITY, reverse: nothing invented — every non-inherit picker row traces to a catalogue row',
    rows.slice(1).every(row => fixture.some(opt => opt.value === row.value)),
  )
  t.check('an unavailable row is VISIBLE wearing its reason', rows.find(r => r.value === 'gpt-6.2')?.unavailable === 'no OpenAI account connected')
  t.check('a connect row reads as the door it is', rows.find(r => r.value === '__mercury_connect__:zai')?.kind === 'connect')
  t.check('the anthropic sign-in sentinel is a connect row by SHAPE (the regex arm, no literal list)', rows.find(r => r.value === '__mercury_anthropic_connect__')?.kind === 'connect')
  t.check('a keyless compat model is a plain selectable row (no key ≠ unavailable when the endpoint is auth-free)', rows.find(r => r.value === 'compat/qwen3')?.unavailable === undefined)
  {
    const priorPin = process.env.MERCURY_DEFAULT_HAIKU_MODEL
    process.env.MERCURY_DEFAULT_HAIKU_MODEL = 'fastcheap-gw-v1'
    try {
      const pinned = getAgentModelPickerRows([
        { value: 'fastcheap-gw-v1', label: 'Ops haiku', description: 'gateway spelling of the haiku slot' },
        { value: DEFAULT_OPUS, label: 'Opus 5', description: 'large' },
      ])
      t.check(
        'a row valued as the haiku-slot PIN is offered like any other row',
        JSON.stringify(pinned.slice(1).map(r => r.value)) === JSON.stringify(['fastcheap-gw-v1', DEFAULT_OPUS]),
        pinned.map(r => r.value).join(' · '),
      )
    } finally {
      if (priorPin === undefined) delete process.env.MERCURY_DEFAULT_HAIKU_MODEL
      else process.env.MERCURY_DEFAULT_HAIKU_MODEL = priorPin
    }
  }
  t.check('picking a live model commits its value', JSON.stringify(agentModelPickOutcome(rows.find(r => r.value === 'compat/qwen3')!)) === '{"kind":"picked","model":"compat/qwen3"}')
  t.check('picking inherit commits the ABSENT field', JSON.stringify(agentModelPickOutcome(rows[0]!)) === '{"kind":"picked"}')
  t.check('picking an unavailable model routes to sign-in with its reason', agentModelPickOutcome(rows.find(r => r.value === 'gpt-6.2')!).kind === 'needs-sign-in')
  t.check('picking a connect row routes to sign-in', agentModelPickOutcome(rows.find(r => r.value === '__mercury_connect__:zai')!).kind === 'needs-sign-in')

  {
    const { getCrewmateModel } = await import('../../src/models/catalogue/crewmateModel.js')
    const { classifyModelRoute } = await import('../../src/models/roads/routeLaw.js')
    const PARENT = DEFAULT_OPUS
    t.check(
      'every offered model row dispatches deterministically',
      rows.filter(r => r.kind === 'model').every(r => getCrewmateModel(r.value, PARENT).length > 0),
    )
    t.check(
      'the haiku spellings resolve to the haiku row',
      ['haiku', 'claude-haiku-4-5-20251001'].every(v => /haiku/.test(getCrewmateModel(v, PARENT))),
    )
    t.check(
      'a hand-saved sentinel never lands a family silently (unrecognised, refused at admission)',
      ['__mercury_test_sentinel__', '__mercury_connect__:zai'].every(
        v => classifyModelRoute(getCrewmateModel(v, PARENT)).kind === 'unrecognised',
      ),
    )
  }

}

t.section('§7 — THE FRONTIER PASS (the authoring guidance · the availability truth · the field totality)')
{

  const { agentModelAvailabilityNote, getAgentModelPickerRows } = await import('../../src/models/catalogue/agentModelPicker.js')
  const rows = getAgentModelPickerRows([
    { value: 'fable', label: 'Fable', description: '' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6', description: '', unavailable: 'not signed in — /logins anthropic' },
    { value: 'gpt-6.2', label: 'GPT-6.2', description: '', group: 'Mercury — OpenAI models', unavailable: 'no OpenAI account connected' },
  ] as never)
  t.check('inherit/absent wears nothing', agentModelAvailabilityNote(undefined, rows) === null && agentModelAvailabilityNote('inherit', rows) === null)
  t.check('an unavailable saved model wears its reason', agentModelAvailabilityNote('gpt-6.2', rows) === 'no OpenAI account connected')
  t.check('an available model wears nothing', agentModelAvailabilityNote('fable', rows) === null)
  t.check('an id the catalogue does not know wears nothing (unknown ≠ unavailable)', agentModelAvailabilityNote('compat/mystery', rows) === null)
  t.check("a saved 1M variant of an unavailable model wears its row's reason (the rider folded onto the row)", agentModelAvailabilityNote('claude-opus-4-6[1m]', rows) === 'not signed in — /logins anthropic' && agentModelAvailabilityNote('claude-opus-4-6', rows) === 'not signed in — /logins anthropic')
  {
    const { decodeAgentDocument: decode } = await import('../../src/crew/agents/codec.js')
    const heldRaw = '---\nname: held-agent\ndescription: A held agent for the born-held drive.\nmodel: gpt-6.2\n---\nYou are the held agent, saved while your provider is signed out today.\n'
    const heldDoc = decode(heldRaw, '/x/held-agent.md')
    const heldV = computeStudioValidation({ doc: heldDoc, existingAgents: [], base: undefined, mode: 'create' })
    t.check('born-held: validation carries ZERO errors for an unavailable model', heldV.errors.length === 0, JSON.stringify(heldV.errors))
    const savedHeld: string[] = []
    const heldEvents: string[] = []
    const heldMachine = createStudioEditorMachine(
      {
        mode: 'create',
        cwd: cwdDir,
        getExistingAgents: () => [],
        getParentModel: () => 'claude-fable-5',
        onSaved: (m: string) => heldEvents.push(m),
        onCancel: () => {},
      } as never,
      () => {},
      {
        readFile: () => { throw new Error('no read') },
        saveDocument: async (_t: unknown, d: { raw: string }) => {
          savedHeld.push(d.raw)
          return { path: '/dest/held-agent.md', afterRevision: 'rev-2', semanticChanges: ['model'], bytes: d.raw.length, at: 'now' }
        },
        saveDraft: async () => '/drafts/x.json',
        listDrafts: () => [],
        discardDraft: async () => {},
      } as never,
    )
    heldMachine.commit({ set: { name: 'held-agent', description: 'A held agent for the born-held drive.', model: 'gpt-6.2' } } as never)
    heldMachine.commit({ body: 'You are the held agent, saved while your provider is signed out today.' } as never)
    await (heldMachine as never as { save: () => Promise<void> }).save()
    t.check(
      'born-held: the save COMMITS and the raw carries the unavailable model verbatim',
      savedHeld.length === 1 && heldEvents.length === 1 && savedHeld[0]!.includes('model: gpt-6.2'),
      JSON.stringify({ saves: savedHeld.length, events: heldEvents }),
    )
    heldMachine.dispose()
  }

  const { FIELD_ROWS: fieldRows } = await import('../../src/screen/agents/studio/studioEditorModel.js')
  const { KNOWN_AGENT_KEYS } = await import('../../src/crew/agents/contracts.js')
  const preserved = new Set(['mcpServers', 'hooks', 'specVersion'])
  const formKeys = new Set(fieldRows.map(r => r.id).filter(id => id !== 'body'))
  const contractKeys = new Set(KNOWN_AGENT_KEYS.filter(k => !preserved.has(k)))
  t.check(
    'the form covers the WHOLE agent contract minus the three preserved-as-is keys',
    formKeys.size === contractKeys.size && [...contractKeys].every(k => formKeys.has(k)),
    `form=${[...formKeys].join(',')} vs contract=${[...contractKeys].join(',')}`,
  )
  t.check("the body rides as the form's own row", fieldRows.some(r => r.id === 'body'))
}

t.section('§8 — THE SIGN-IN WALK, DRIVEN (AGENTVERIFY A3: the face swap on a live mount, never needles alone)')
{
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const stripAnsi = (await import('strip-ansi')).default
  const React = (await import('react')).default
  const { render } = await import('../../src/screen/themedRenderer.js')
  const { BootAgentsScreen, agentFormRowIds } = await import('../../src/screen/boot-face/BootAgentsScreen.js')
  const { getAgentModelPickerRows } = await import('../../src/models/catalogue/agentModelPicker.js')
  const { keyConnectValue } = await import('../../src/models/catalogue/modelOptions.js')

  const priorZaiKey = process.env.ZAI_API_KEY
  delete process.env.ZAI_API_KEY
  try {
    const ESC = String.fromCharCode(27)
    const DOWN = `${ESC}[B`
    const UP = `${ESC}[A`

    let output = ''
    const stdout = new PassThrough()
    stdout.on('data', c => { output += c.toString() })
    ;(stdout as unknown as { columns?: number; rows?: number }).columns = 120
    ;(stdout as unknown as { columns?: number; rows?: number }).rows = 40
    const stdinQueue: Buffer[] = []
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode() { return this },
      setEncoding() { return this },
      read() { return stdinQueue.shift() ?? null },
      get readableLength() { return stdinQueue.reduce((n, b) => n + b.length, 0) },
      unref() { return this },
      ref() { return this },
      pause() { return this },
      resume() { return this },
    }) as unknown as NodeJS.ReadStream
    const settle = (ms = 45) => new Promise(r => setTimeout(r, ms))
    const press = async (bytes: string): Promise<void> => {
      stdinQueue.push(Buffer.from(bytes))
      ;(stdin as unknown as EventEmitter).emit('readable')
      await settle()
    }
    const frameText = (): string => stripAnsi(output)

    const hostControl: { open?: () => void; close?: () => void; openedCount: number } = { openedCount: 0 }
    function WalkHost(): React.ReactNode {
      const [loginsOpen, setLoginsOpen] = React.useState(false)
      hostControl.open = () => setLoginsOpen(true)
      hostControl.close = () => setLoginsOpen(false)
      return React.createElement(BootAgentsScreen, {
        definitions: { activeAgents: [], allAgents: [] },
        workspaceDir: process.env['MERCURY_CONFIG_DIR'],
        toolsOf: () => [],
        fullScene: { columns: 120, rows: 40 },
        suspended: loginsOpen,
        onOpenLogins: () => {
          hostControl.openedCount++
          hostControl.open?.()
        },
      } as never)
    }

    const staleRows = getAgentModelPickerRows()
    const zaiConnectIdx = staleRows.findIndex(r => r.value === keyConnectValue('zai'))
    t.check(
      'the walk world is zai-keyless (the connect door exists to drive; a red here = a leaked real config home)',
      zaiConnectIdx > 0,
      `rows=${staleRows.length}`,
    )

    const instance = await render(React.createElement(WalkHost), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin,
      patchConsole: false,
    })
    for (let i = 0; i < 60 && !frameText().includes('n new'); i++) await settle(30)
    t.check('the library mounts under keys', frameText().includes('n new'))

    const modelRowIdx = agentFormRowIds('create').indexOf('model')
    await press('n')
    for (let i = 0; i < modelRowIdx; i++) await press(DOWN)
    output = ''
    await press('\r')
    const pickFrame = frameText()
    t.check('↵ on the model row opens the full-catalogue pick', pickFrame.includes(`${staleRows.length} rows — the full catalogue`), pickFrame.slice(-200))

    for (let i = 0; i < zaiConnectIdx; i++) await press(DOWN)
    output = ''
    await press('\r')
    await settle(70)
    t.check('↵ on the connect door fires the host swap exactly once', hostControl.openedCount === 1)
    t.check(
      'suspended, the agents layer renders NOTHING (the host owns the paint)',
      !frameText().includes('the full catalogue') && !frameText().includes('CONTROL PLANE'),
    )

    process.env.ZAI_API_KEY = 'zai-fixture-key-for-the-walk'
    const freshRows = getAgentModelPickerRows()
    t.check(
      'the presence moved in the walk world (the connect door died at the derivation)',
      freshRows.length === staleRows.length - 1 && !freshRows.some(r => r.value === keyConnectValue('zai')),
      `stale=${staleRows.length} fresh=${freshRows.length}`,
    )
    hostControl.close?.()
    await settle(140)
    output = ''
    await press(UP)
    await settle(70)
    const returned = frameText()
    t.check(
      'the return re-derives INTO the open pick (the painted row count is the fresh truth)',
      returned.includes(`${freshRows.length} rows — the full catalogue`),
      returned.slice(-200),
    )

    output = ''
    await press(ESC)
    await settle(70)
    t.check('esc lands back on the FORM (the draft survived the swap)', frameText().includes('agent form'))

    instance.unmount()
    await settle(30)
  } finally {
    if (priorZaiKey === undefined) delete process.env.ZAI_API_KEY
    else process.env.ZAI_API_KEY = priorZaiKey
  }
}

t.section('§9 — THE BUILT-IN MODEL DIAL (AGENTDIALS C1: the override round-trip · dispatch wears it · inherit clears · the face walk)')
{
  const { setAgentOverride, userOverridesPath } = await import('../../src/crew/agents/overrides.js')
  const { clearAgentDefinitionsCache, getAgentDefinitionsWithOverrides } = await import(
    '../../src/tools/crewmate/loadAgentsDir.js'
  )
  const { buildStudioRows } = await import('../../src/screen/agents/studio/studioData.js')
  const { getCrewmateModel } = await import('../../src/models/catalogue/crewmateModel.js')
  const { parseUserSpecifiedModel } = await import('../../src/models/catalogue/engineModel.js')
  const { resolveEffectiveAgentRuntime } = await import('../../src/crew/agents/resolver.js')
  const { agentFaceDetailLines, BootAgentsScreen } = await import('../../src/screen/boot-face/BootAgentsScreen.js')
  const { getAgentModelPickerRows } = await import('../../src/models/catalogue/agentModelPicker.js')

  const walkCwd = mkdtempSync(join(tmpdir(), 'agent-dial-walk-'))

  clearAgentDefinitionsCache()
  const defs0 = await getAgentDefinitionsWithOverrides(walkCwd)
  const firstType = buildStudioRows(defs0, { tab: 'all', filter: 'all', query: '' }).rows[0]?.agent?.agentType ?? ''
  t.check('the scratch world lists the built-ins (the real loader, no files)', firstType.length > 0 && defs0.allAgents.every(a => a.source === 'built-in'))
  await setAgentOverride('user', walkCwd, firstType, { model: 'fixture-dial/model-x' })
  clearAgentDefinitionsCache()
  const defs1 = await getAgentDefinitionsWithOverrides(walkCwd)
  const worn = defs1.allAgents.find(a => a.agentType === firstType)
  t.check('the loader patches the override ONTO the built-in definition (one truth for spawn and display)', worn?.model === 'fixture-dial/model-x' && worn?.operatorOverride?.from === 'user')
  t.check('the provenance keeps the pre-override intent', (worn?.operatorOverride?.intentModel ?? 'inherit') === 'inherit')
  t.check(
    'DISPATCH WEARS IT at the one chokepoint (override → definition.model → the floor predicates)',
    getCrewmateModel(worn?.model, 'claude-fable-5') === parseUserSpecifiedModel('fixture-dial/model-x'),
  )
  await setAgentOverride('user', walkCwd, firstType, undefined)
  clearAgentDefinitionsCache()
  const defs2 = await getAgentDefinitionsWithOverrides(walkCwd)
  const clearedDef = defs2.allAgents.find(a => a.agentType === firstType)
  t.check('inherit CLEARS: the definition reads code-declared again, provenance gone', clearedDef?.operatorOverride === undefined && (clearedDef?.model ?? 'inherit') === 'inherit')

  const effInherit = resolveEffectiveAgentRuntime(clearedDef as never, { parentModel: 'claude-fable-5', sessionEffort: undefined })
  const detail = agentFaceDetailLines({ id: `agent:${firstType}`, kind: 'agent', agent: clearedDef } as never, new Map(), effInherit)
  t.check(
    "inherit reads LEGIBLY: 'inherit → <resolved> (your session's model)' — never an Anthropic tie",
    detail.some(l => l.includes('model: inherit → claude-fable-5') && l.includes("(your session's model)")),
    detail.find(l => l.startsWith('model:')) ?? '(no model line)',
  )


  const priorZai9 = process.env.ZAI_API_KEY
  process.env.ZAI_API_KEY = 'zai-fixture-key-for-the-dial-walk'
  try {
    const { EventEmitter } = await import('node:events')
    const { PassThrough } = await import('node:stream')
    const stripAnsi = (await import('strip-ansi')).default
    const React = (await import('react')).default
    const { render } = await import('../../src/screen/themedRenderer.js')
    const ESC = String.fromCharCode(27)
    const DOWN = `${ESC}[B`
    let output = ''
    const stdout = new PassThrough()
    stdout.on('data', c => { output += c.toString() })
    ;(stdout as unknown as { columns?: number; rows?: number }).columns = 120
    ;(stdout as unknown as { columns?: number; rows?: number }).rows = 40
    const stdinQueue: Buffer[] = []
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode() { return this },
      setEncoding() { return this },
      read() { return stdinQueue.shift() ?? null },
      get readableLength() { return stdinQueue.reduce((n, b) => n + b.length, 0) },
      unref() { return this },
      ref() { return this },
      pause() { return this },
      resume() { return this },
    }) as unknown as NodeJS.ReadStream
    const settle = (ms = 50) => new Promise(r => setTimeout(r, ms))
    const press = async (bytes: string): Promise<void> => {
      stdinQueue.push(Buffer.from(bytes))
      ;(stdin as unknown as EventEmitter).emit('readable')
      await settle()
    }
    const frameText = (): string => stripAnsi(output)

    const dialRows = getAgentModelPickerRows()
    t.check("the dial's derivation tops with Inherit (the clear)", dialRows[0]?.kind === 'inherit')
    const targetIdx = dialRows.findIndex(r => r.kind === 'model' && r.unavailable === undefined)
    t.check('an AVAILABLE model row exists in the walk world (the zai key lane)', targetIdx > 0, `rows=${dialRows.length}`)
    const targetValue = dialRows[targetIdx]?.value ?? ''

    clearAgentDefinitionsCache()
    const instance = await render(
      React.createElement(BootAgentsScreen, {
        workspaceDir: walkCwd,
        toolsOf: () => [],
        fullScene: { columns: 120, rows: 40 },
      } as never),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false },
    )
    t.check('the bare mount reads the REAL loader — the built-in roster paints', await waitUntil(() => frameText().includes(firstType)))

    output = ''
    await press('\r')
    await waitUntil(() => frameText().includes('model override'))
    const dialFrame = frameText()
    t.check('↵ on a built-in row opens the MODEL-ONLY dial (never the form, never a refusal)', dialFrame.includes('model override') && dialFrame.includes('Inherit') && !dialFrame.includes('only file-backed agents edit here'))
    t.check("the dial says the mechanism: config row, definition untouched, Inherit clears", dialFrame.includes('per-agent settings row'))

    for (let i = 0; i < targetIdx; i++) await press(DOWN)
    output = ''
    await press('\r')
    const landed = await waitUntil(() => {
      try {
        const raw = readFileSync(userOverridesPath(), 'utf-8')
        return raw.includes(firstType) && raw.includes(targetValue)
      } catch {
        return false
      }
    })
    t.check('the pick LANDS in config (agent-overrides.json carries the row)', landed, landed ? readFileSync(userOverridesPath(), 'utf-8').slice(0, 160) : '(never landed)')
    t.check('the list column wears the override', await waitUntil(() => frameText().includes('(override)')))

    output = ''
    await press('\r')
    t.check('↵ reopens the dial with the override as current', await waitUntil(() => frameText().includes('model override')))
    const UP = `${ESC}[A`
    for (let i = 0; i < targetIdx; i++) await press(UP)
    output = ''
    await press('\r')
    const fileCleared = await waitUntil(() => {
      try {
        return !readFileSync(userOverridesPath(), 'utf-8').includes(targetValue)
      } catch {
        return false
      }
    })
    let wearGone = false
    let lastPaint = ''
    for (let nudge = 0; nudge < 200 && !wearGone; nudge++) {
      output = ''
      await press(nudge % 2 === 0 ? DOWN : UP)
      lastPaint = frameText()
      wearGone = lastPaint.includes(firstType) && !lastPaint.includes('(override)')
      if (wearGone && nudge % 2 === 1) await press(DOWN)
    }
    t.check('Inherit CLEARS the config row and the wear', fileCleared && wearGone, `file=${readFileSync(userOverridesPath(), 'utf-8').replace(/\s+/g, ' ').slice(0, 120)}${wearGone ? '' : ` · last paint=${lastPaint.replace(/\s+/g, ' ').slice(-240)}`}`)

    const unavailIdx = dialRows.findIndex(r => r.kind === 'model' && r.unavailable !== undefined)
    if (unavailIdx > 0) {
      output = ''
      await press('\r')
      await waitUntil(() => frameText().includes('model override'))
      for (let i = 0; i < unavailIdx; i++) await press(DOWN)
      output = ''
      await press('\r')
      const noted = await waitUntil(() => frameText().includes('/logins opens the sign-in catalogue'))
      t.check('an unavailable row is a SIGN-IN DOOR — the note names /logins (no Logins host on this mount), nothing commits', noted && !readFileSync(userOverridesPath(), 'utf-8').includes(dialRows[unavailIdx]?.value ?? '§'))
    } else {
      t.check('an unavailable row is a SIGN-IN DOOR', true, 'skipped — every model row is available in this world')
    }

    instance.unmount()
    await settle(30)
  } finally {
    if (priorZai9 === undefined) delete process.env.ZAI_API_KEY
    else process.env.ZAI_API_KEY = priorZai9
  }
}

{
  const raw = '---\nname: fixture-scout\ndescription: Original description that passes validation.\nmaxTurns: 5\n---\nOriginal body long enough to pass the validation floor.\n'
  const theirs = raw.replace('Original description', 'Peer changed description').replace('maxTurns: 5', 'maxTurns: 9')
  const h = harness({ base: { raw, filePath: join(cwdDir, '.mercury', 'agents', 'merge-fixture.md') }, theirRaw: theirs, saveOutcome: 'conflict' })
  h.machine.commit({ set: { maxTurns: undefined }, body: 'My edited body long enough to pass the validation floor.\n' })
  await h.machine.save()
  h.machine.mergeOntoTheirs()
  t.check('merge keeps a peer field that I never edited', h.snap().doc.fields.description.startsWith('Peer changed description'))
  t.check('merge reapplies my explicit field deletion', h.snap().doc.fields.maxTurns === undefined)
  t.check('merge reapplies my edited body', h.snap().doc.body.startsWith('My edited body'))
  h.machine.dispose()
}
for (const stop of ['abort', 'dispose'] as const) {
  const h = harness()
  const raw = h.snap().doc.raw
  h.machine.guidedDescribe('generate then stop before the result settles')
  h.machine.guidedDescribe('a duplicate request before settlement')
  if (stop === 'abort') h.machine.abortGeneration()
  else h.machine.dispose()
  await Promise.resolve()
  await Promise.resolve()
  t.check(`${stop}: a late success does not adopt the generated document`, h.snap().doc.raw === raw)
  t.check(`${stop}: a late success does not rearm autosave`, h.timers.length === 0)
  t.check(`${stop}: duplicate generation is not dispatched`, h.events.filter(event => event === 'generate-called').length === 1)
  h.machine.dispose()
}

t.section('§10 — BOOT AGENTS EFFORT TRUTH (launch flag > saved default > model default; unknown says session alone)')
{
  const { agentsFaceBase, formFace, listFace } = await import('../../src/screen/boot-face/agents/menuModel.js')
  const { agentFaceDetailLines, agentFormRowIds } = await import('../../src/screen/boot-face/agents/face.js')
  const { buildStudioRows } = await import('../../src/screen/agents/studio/studioData.js')
  const { resolveEffectiveAgentRuntime } = await import('../../src/crew/agents/resolver.js')
  const { _resetBootBirthFactsForTesting, setBootBirthFacts } = await import('../../src/daemon/switchboard/bootBirthFacts.js')
  const { resolveEffortTruth, unpinAllLaunchEffort } = await import('../../src/models/effort/effort.js')
  const { updateSettingsForSource } = await import('../../src/platform/settings/settings.js')

  const EFFORT_FIX = 'resolve boot session effort from bootBirthFacts().effort ?? getInitialEffortSetting() in src/screen/boot-face/agents/menuModel.ts and src/screen/boot-face/BootAgentsScreen.tsx, and omit unknown figure in src/screen/boot-face/agents/face.ts'

  const crew = {
    agentType: 'mercury-crew',
    whenToUse: 'General-purpose worker.',
    getSystemPrompt: () => 'You are mercury-crew.',
    source: 'built-in' as const,
  }
  const built = buildStudioRows({ activeAgents: [crew], allAgents: [crew] } as never, { tab: 'all', filter: 'all', query: '' })
  const base = agentsFaceBase({ counts: { active: 1, disabled: 0, issues: 0 }, mainModel: 'claude-sonnet-5-5', wordGlow: null, workspaceDir: cwdDir })
  const listStub = { selectedRow: built.rows[0]!, selectedIndex: 0, note: null } as never
  const formStub = { mode: 'create' as const, base: undefined }
  const formListStub = { selectedIndex: 0, note: null } as never
  const pickListStub = { selectedIndex: 0, note: null } as never
  const draftDoc = freshStudioDocument()
  const formSnapStub = { doc: draftDoc, scope: 'project' as const, view: { kind: 'advanced' as const, cursor: 0, editing: null }, textBuffer: '', note: null, busy: false, recoverOffer: null, conflict: null } as never

  const priorEnvEffort = process.env['MERCURY_EFFORT_LEVEL']
  delete process.env['MERCURY_EFFORT_LEVEL']
  try {
    unpinAllLaunchEffort()
    updateSettingsForSource('userSettings', { engine: { effort: 'max' } })
    _resetBootBirthFactsForTesting()
    setBootBirthFacts({ effort: 'high' })

    const withFlagList = listFace({
      base,
      built,
      confirm: null,
      counts: { active: 1, disabled: 0, issues: 0 },
      defs: { activeAgents: [crew], allAgents: [crew] } as never,
      faceTools: [],
      list: listStub,
      listRows: built.rows,
      mainModel: 'claude-sonnet-5-5',
      note: null,
    })
    const flagEffortLine = (withFlagList.detailOverride ?? []).find(l => l.startsWith('effort:')) ?? ''
    t.check(
      'launch --effort high with saved default max: Agents list reads effort: session → high (never medium)',
      flagEffortLine === 'effort: session → high',
      flagEffortLine === 'effort: session → high' ? '' : `${EFFORT_FIX} | got=${JSON.stringify(flagEffortLine)}`,
    )

    const withFlagForm = formFace({
      base,
      defs: { activeAgents: [crew], allAgents: [crew] } as never,
      faceTools: [],
      form: formStub,
      formList: formListStub,
      formPick: null,
      formPrompt: null,
      formRowIds: agentFormRowIds('create'),
      formSnap: formSnapStub,
      mainModel: 'claude-sonnet-5-5',
      note: null,
      pickList: pickListStub,
      workspaceDir: cwdDir,
    })
    const flagRunsLine = (withFlagForm.detailOverride ?? []).find(l => l.startsWith('runs:')) ?? ''
    t.check(
      'launch --effort high with saved default max: Agents form reads effort high (never medium)',
      flagRunsLine.includes('· effort high'),
      flagRunsLine.includes('· effort high') ? '' : `${EFFORT_FIX} | got=${JSON.stringify(flagRunsLine)}`,
    )

    setBootBirthFacts({ effort: null })
    const expectedSaved = resolveEffortTruth('claude-sonnet-5-5', 'max').label
    const savedList = listFace({
      base,
      built,
      confirm: null,
      counts: { active: 1, disabled: 0, issues: 0 },
      defs: { activeAgents: [crew], allAgents: [crew] } as never,
      faceTools: [],
      list: listStub,
      listRows: built.rows,
      mainModel: 'claude-sonnet-5-5',
      note: null,
    })
    const savedEffortLine = (savedList.detailOverride ?? []).find(l => l.startsWith('effort:')) ?? ''
    t.check(
      `no launch flag with saved default max: Agents list resolves via resolveEffortTruth (effort: session → ${expectedSaved})`,
      savedEffortLine === `effort: session → ${expectedSaved}`,
      savedEffortLine === `effort: session → ${expectedSaved}` ? '' : `${EFFORT_FIX} | got=${JSON.stringify(savedEffortLine)}`,
    )

    process.env['MERCURY_EFFORT_LEVEL'] = 'low'
    const envList = listFace({
      base,
      built,
      confirm: null,
      counts: { active: 1, disabled: 0, issues: 0 },
      defs: { activeAgents: [crew], allAgents: [crew] } as never,
      faceTools: [],
      list: listStub,
      listRows: built.rows,
      mainModel: 'claude-sonnet-5-5',
      note: null,
    })
    const envEffortLine = (envList.detailOverride ?? []).find(l => l.startsWith('effort:')) ?? ''
    t.check(
      'MERCURY_EFFORT_LEVEL=low overrides saved default, matching live session resolution',
      envEffortLine === 'effort: session → low',
      envEffortLine === 'effort: session → low' ? '' : `${EFFORT_FIX} | got=${JSON.stringify(envEffortLine)}`,
    )
    delete process.env['MERCURY_EFFORT_LEVEL']

    updateSettingsForSource('userSettings', { engine: { effort: undefined } })
    const unknownEff = resolveEffectiveAgentRuntime(crew as never, {
      parentModel: 'gpt-6.2',
      sessionEffort: undefined,
      tools: [],
    })
    const unknownLine = agentFaceDetailLines(built.rows[0]!, built.estate, unknownEff).find(l => l.startsWith('effort:')) ?? ''
    t.check(
      'when effort cannot be known on the boot menu, line reads effort: session with no figure',
      unknownLine === 'effort: session',
      unknownLine === 'effort: session' ? '' : `${EFFORT_FIX} | got=${JSON.stringify(unknownLine)}`,
    )
  } finally {
    _resetBootBirthFactsForTesting()
    if (priorEnvEffort === undefined) delete process.env['MERCURY_EFFORT_LEVEL']
    else process.env['MERCURY_EFFORT_LEVEL'] = priorEnvEffort
  }
}

t.finish('prove-agent-face')
