#!/usr/bin/env bun
// ============================================================================
// scripts/ui/prove-agent-face.ts — 's own gate: the agent
//  studio's ONE form machine + its skins.
//
//    §1 IDENTITY BOTH DIRECTIONS (the extraction law, C1): every gate,
//       transition and spelling lives in studioEditorModel.ts; the Ink
//       StudioEditor skin retains NONE of them; the machine module is
//       React-free (no ink/react import, no JSX); the in-chat mount frames
//       byte-match the fixtures captured at the base tree (the
//       byte-preservation floor — agent-face-stills.ts compares).
//    §2 THE MACHINE WALKED WHOLE (fakes + hand-driven beats): the guided
//       flow's gates and successors, the patch door's fail-closed refusal,
//       the save road (gate refusal · receipt spelling · draft discard),
//       the revision-conflict arm + merge-onto-theirs re-anchor, draft
//       recovery both answers, the autosave debounce beat on an injected
//       timer, generation (settle + abort), raw-view load diagnostics,
//       the advanced text-field parse rules, and the pure projections
//       (validation · destination · review facts).
//
//  cpu-pure: machine walks with injected seams + one spawned still-compare
//  (an off-screen Ink string render inside) — never a PTY, a daemon, a
//  boot, or a live model call.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, waitUntil } from '../engine-durability/harness.ts'

process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'agent-face-prove-'))

const t = checker()

const repoRoot = join(import.meta.dirname, '..', '..')
const modelSrc = readFileSync(join(repoRoot, 'src/components/agents/studio/studioEditorModel.ts'), 'utf-8')
const skinSrc = readFileSync(join(repoRoot, 'src/components/agents/studio/StudioEditor.tsx'), 'utf-8')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

// The AgentTool cycle's bun entry-order law (the constants-leaf
// TDZ class): a bare-bun entry through resolver → agentToolUtils re-enters
// AgentTool.tsx mid-init and trips its lazySchema TDZ; entering through the
// tool module FIRST settles the order the way the app graph does.
await import('../../src/tools/AgentTool/AgentTool.js')

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
} = await import('../../src/components/agents/studio/studioEditorModel.js')
const { decodeAgentDocument } = await import('../../src/services/agents/codec.js')
const { AgentStoreError } = await import('../../src/services/agents/store.js')
const { revisionDigest } = await import('../../src/services/agents/contracts.js')

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — IDENTITY BOTH DIRECTIONS (the extraction law)')
{
  // The machine's spellings — the gates, refusals and receipts the operator
  // reads. Each must live in the MODEL and be absent from the SKIN.
  const machineSpellings = [
    'fix the errors above before saving',
    'the file changed outside this draft',
    'their version loaded — your field edits re-applied on top',
    'draft recovered — continuing where you left off',
    'draft unreadable — starting fresh',
    'generation cancelled',
    'generating agent from description',
    'generation failed:',
    'max turns must be a positive integer (empty clears)',
    'system prompt is too short (minimum 20 characters)',
    'description is required — it tells Mercury when to delegate',
    'edit refused:',
    'raw edit loaded',
    'already exists (',
    'precedence decides the winner',
    'Description should say when to delegate',
  ]
  // AGENTVERIFY A7: the FACE skin is the extraction's third surface — it
  // paints snapshot notes, never owns a spelling (a duplicate would be the
  // second-home disease §4 forbids at the data plane).
  const faceSkinSrc = readFileSync(join(repoRoot, 'src/components/BootAgentsScreen.tsx'), 'utf-8')
  for (const s of machineSpellings) {
    t.check(`model owns: "${s.slice(0, 44)}"`, modelSrc.includes(s), s)
    t.check(`skin retains no "${s.slice(0, 40)}"`, !skinSrc.includes(s), s)
    t.check(`face skin retains no "${s.slice(0, 36)}"`, !faceSkinSrc.includes(s), s)
  }
  // The other direction: the machine module is React-free — no ink, no
  // react, no JSX pragma path; the skin is the ONLY Ink holder.
  const reactTokens = ["from 'react'", 'from "../../../ink', "from '../../../ink"]
  const hits = reactTokens.filter(tok => modelSrc.includes(tok))
  t.check('the machine module imports neither react nor ink', hits.length === 0, hits.join(','))
  // The mechanical no-JSX guarantee is the extension: a .ts module cannot
  // carry JSX (the compiler refuses it), and the import pin above keeps the
  // render libraries out of its graph.
  t.check(
    'the machine lives in a .ts module (JSX mechanically impossible)',
    existsSync(join(repoRoot, 'src/components/agents/studio/studioEditorModel.ts')) &&
      !existsSync(join(repoRoot, 'src/components/agents/studio/studioEditorModel.tsx')),
  )
  // The skin re-exports the draft-base type so AgentStudio's import home is
  // unchanged (the byte-preserved caller law).
  t.check(
    'the skin re-exports StudioDraftBase from the model',
    skinSrc.includes("export type { StudioDraftBase } from './studioEditorModel.js'"),
  )
  const agentStudioSrc = readFileSync(join(repoRoot, 'src/components/agents/studio/AgentStudio.tsx'), 'utf-8')
  t.check(
    "AgentStudio still imports the editor from './StudioEditor.js' (untouched caller)",
    agentStudioSrc.includes("from './StudioEditor.js'"),
  )

  // The in-chat mount frames byte-match the base-captured fixtures.
  const stills = Bun.spawnSync(['bun', join(repoRoot, 'scripts/ui/agent-face-stills.ts')], { cwd: repoRoot })
  const out = stills.stdout.toString() + stills.stderr.toString()
  t.check('the in-chat mount frames byte-match the base fixtures', stills.exitCode === 0 && out.includes('PASS inchat-create-guided') && out.includes('PASS inchat-edit-advanced'), out.slice(0, 400))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — THE MACHINE WALKED WHOLE (fakes + hand-driven beats)')

type Snap = ReturnType<ReturnType<typeof createStudioEditorMachine>['snapshot']>

function harness(opts?: {
  base?: { raw: string; filePath: string }
  drafts?: { path: string; draft: { baseIdentity?: { filePath: string; revision: string }; raw: string } }[]
  saveOutcome?: 'ok' | 'conflict'
  generateBehaviour?: 'settle' | 'hang'
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
  const theirRaw = '---\nname: fixture-scout\ndescription: Their newer description, written elsewhere on disk.\n---\nTheir newer body, long enough to stand as a real system prompt.\n'
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
  // The guided walk, gate by gate, to a clean save.
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
  // The save gate refuses while errors exist (the review binding).
  const h = harness()
  await h.machine.save()
  t.check('save refuses on validation errors with the gate spelling', h.lastNote() === 'fix the errors above before saving' && h.saved.length === 0)
}

{
  // The guided back topology: pop, and cancel off the empty stack.
  const h = harness()
  h.machine.guidedDestination('project')
  h.machine.guidedBack()
  t.check('back pops to destination', (h.snap().view as { step: string }).step === 'destination')
  h.machine.guidedBack()
  t.check('back off the empty history cancels', h.events.includes('cancel'))
}

{
  // reviewEscape: create → the guided model step wearing the whole history.
  const h = harness()
  h.machine.setView({ kind: 'review' })
  h.machine.reviewEscape()
  const v = h.snap().view as { kind: string; step?: string; history?: string[] }
  t.check('review esc (create) restores the guided model step with the six-step history', v.kind === 'guided' && v.step === 'model' && JSON.stringify(v.history) === JSON.stringify(['destination', 'method', 'identity', 'prompt', 'description', 'tools']))
}

{
  // The revision-conflict arm + merge-onto-theirs.
  const baseRaw = '---\nname: fixture-scout\ndescription: The base description as discovered on disk today.\n---\nThe base body, long enough to be a lawful system prompt for the walk.\n'
  const h = harness({ base: { raw: baseRaw, filePath: join(cwdDir, '.mercury', 'agents', 'fixture-scout.md') }, saveOutcome: 'conflict' })
  t.check('edit opens on the advanced list over the re-read base bytes', h.snap().view.kind === 'advanced' && h.snap().doc.raw === baseRaw)
  h.machine.commitTextField('description', 'My newer description, edited in this draft with intent.')
  await h.machine.save()
  t.check('a conflicted save arms the conflict with its spelling', h.snap().conflict !== null && h.lastNote().startsWith('the file changed outside this draft'))
  h.machine.mergeOntoTheirs()
  const merged = h.snap()
  // The landed merge semantics: MY changed fields re-apply over theirs, and
  // MY body re-applies whenever the bodies differ — even when the difference
  // is theirs (identity law: the machine pins what the skin did).
  t.check('merge re-applies MY changed field and MY body over their bytes', merged.doc.fields.description === 'My newer description, edited in this draft with intent.' && merged.doc.body.startsWith('The base body'))
  t.check('merge re-anchors the base revision to theirs', merged.baseRevision === revisionDigest(h.theirRaw))
  t.check('merge clears the conflict and speaks the re-apply spelling', merged.conflict === null && merged.note?.text.startsWith('their version loaded'))
}

{
  // Draft recovery, both answers.
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
  // The autosave debounce beat on the injected timer.
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
  // Generation: the settle road.
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
  // Generation: the abort road (busy-esc).
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
  // Raw-view load: no-op on same bytes; diagnostics on broken bytes.
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
  // The advanced text-field parse rules.
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
  // The pure projections.
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

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — THE FACE SKIN (BootAgentsScreen: the real mount · route silence · the composer tiers)')
{
  const faceSrc = readFileSync(join(repoRoot, 'src/components/BootAgentsScreen.tsx'), 'utf-8')

  // Route silence, structural: the module never touches the surface-route
  // bridge — the route cannot move because this screen exists (the
  // face-doors law; this screen does not even import the lawful plain door,
  // its host closes it by state alone).
  const routeTokens = ['surfaceRoute', 'enterRootRepl', 'settleAbsentChat', 'armRootCommand', 'leaveCurrentSurface', 'initialMessage']
  const routeHits = routeTokens.filter(tok => faceSrc.includes(tok))
  t.check('the face module never touches the surface-route bridge', routeHits.length === 0, routeHits.join(','))

  // The freshness roads, structural: the loader fresh + the live watch +
  // the maybe-store push (the maybe-store precedent) + the watch arm for
  // a fresh boot.
  for (const needle of [
    'getAgentDefinitionsWithOverrides',
    'clearAgentDefinitionsCache',
    'subscribeAgentsChanged',
    'startAgentWatch',
    'useSetAppStateMaybe',
    'reloadAgentDefinitionsIntoAppState',
  ]) {
    t.check(`the face rides the freshness road: ${needle}`, faceSrc.includes(needle))
  }

  // Route silence on the LIVE store around a real mount + the mount itself.
  const routeStore = await import('../../src/context/surfaceRoute.js')
  const versionBefore = routeStore.surfaceRouteVersion()
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootAgentsScreen } = await import('../../src/components/BootAgentsScreen.js')
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

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — TWO SKINS, ONE MODEL (the face consumes the machine; no second home)')
{
  const faceSrc = readFileSync(join(repoRoot, 'src/components/BootAgentsScreen.tsx'), 'utf-8')
  t.check('the face drives the ONE machine', faceSrc.includes('createStudioEditorMachine('))
  t.check('the face lists through the ONE library projection', faceSrc.includes('buildStudioRows'))
  t.check('the face paints values through the ONE field labeller', faceSrc.includes('fieldValueLabel'))
  t.check('the face validates through the ONE gate', faceSrc.includes('computeStudioValidation'))
  // The machine's spellings live in the machine ALONE — the face skin
  // retains none either (the §1 sweep extended to the second skin).
  const machineSpellings = [
    'fix the errors above before saving',
    'the file changed outside this draft',
    'their version loaded — your field edits re-applied on top',
    'draft recovered — continuing where you left off',
    'generation cancelled',
    'max turns must be a positive integer (empty clears)',
    'system prompt is too short (minimum 20 characters)',
    'edit refused:',
  ]
  for (const s of machineSpellings) {
    t.check(`the face retains no "${s.slice(0, 40)}"`, !faceSrc.includes(s), s)
  }
}

// ────────────────────────────────────────────────────────────────────────────
t.section("§5 — THE ROW, BOTH HOSTS (under kit, over doctor — the ruled position; the 'agents' wire word)")
{
  const { assembleCardRows } = await import('../../assets/splash/splash-core.mjs')
  const rowsOf = (facts: Record<string, unknown>): Array<{ key: string; icon: string; label: string; ctx: string }> =>
    assembleCardRows(facts) as never
  const BASE = { cwdBase: 'proj', continueTarget: null, menuAvailable: true }
  const FULL = { ...BASE, concourse: { ctx: 'the live board' } }
  const CHAT = { ...BASE, concourse: null }
  const full = rowsOf(FULL).map(r => r.key)
  const chat = rowsOf(CHAT).map(r => r.key)
  t.check(
    'the full world carries the agents row directly after the kit row (the ruled under-kit position, operator-vetoable)',
    full.indexOf('agents') === full.indexOf('kit') + 1 && full.indexOf('doctor') === full.indexOf('agents') + 1,
    full.join(' · '),
  )
  t.check('the --chat world carries the SAME row at the SAME place (identical worlds)', chat.indexOf('agents') === chat.indexOf('kit') + 1)
  const row = rowsOf(FULL).find(r => r.key === 'agents')
  t.check(
    "the row's bytes: ◈ · 'Agents' · the ruled standing ctx 'create and edit agents'",
    row?.icon === '◈' && row?.label === 'Agents' && row?.ctx === 'create and edit agents',
    JSON.stringify(row),
  )
  t.check('the runtime host-truth ctx rides facts.agentsCtx', rowsOf({ ...FULL, agentsCtx: '3 agents' }).find(r => r.key === 'agents')?.ctx === '3 agents')
  t.check('the row rides the SAME fit law as the menu/kit doors', !rowsOf({ ...FULL, menuAvailable: false }).map(r => r.key).includes('agents'))

  // The wire word, whole: ACTIONS admits it, the arm is once-consumed, a
  // stale receipt arms nothing (prove-splash-receipt drives the matrix —
  // this is the consume-once pin).
  const { decideSplashReceipt, consumeFaceDoorDeepLink } = await import('../../src/substrate/splashHandover.js')
  const now = 1_700_000_000_000
  const fresh = decideSplashReceipt(JSON.stringify({ version: 1, ts: now, action: 'agents' }), now, () => true)
  t.check("the 'agents' receipt applies with nothing to chdir or splice", fresh.reason === 'applied' && fresh.apply === null)
  t.check("the receipt arms the 'agents' face door exactly once", consumeFaceDoorDeepLink() === 'agents' && consumeFaceDoorDeepLink() === null)

  // Both hosts activate it: the face opens the layer; the launcher writes
  // the receipt action (one owner each — the kit-row precedent).
  const splashSrc = readFileSync(join(repoRoot, 'src/components/BootSplashScreen.tsx'), 'utf-8')
  const driverSrc = readFileSync(join(repoRoot, 'assets/splash/mercury-splash.mjs'), 'utf-8')
  const coreSrc = readFileSync(join(repoRoot, 'assets/splash/splash-core.mjs'), 'utf-8')
  t.check("the runtime face activates the row (runRow case 'agents' opens the layer)", splashSrc.includes("case 'agents':") && splashSrc.includes('setAgentsOpen(true)'))
  t.check('the face consumes the deep-link at mount and gates its list on the layer', splashSrc.includes("faceDoor === 'agents'") && splashSrc.includes('!agentsOpen'))
  t.check('the roster glance re-reads at layer close (never optimistic)', splashSrc.includes('setAgentsEpoch(e => e + 1)'))
  t.check("the launcher activates the row with the `agents` receipt action", driverSrc.includes("else if (r2.key === 'agents') writeSplashAction('agents')"))
  t.check('ONE row owner — no second agents row on either host', (coreSrc.match(/key: 'agents'/g) ?? []).length === 1 && !driverSrc.includes("key: 'agents',") && !splashSrc.includes("key: 'agents',"))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§6 — THE MULTIAUTH MANDATE (any model from the catalogue · truly provider-neutral · sign-in routing)')
{
  const { agentModelPickOutcome, getAgentModelPickerRows } = await import('../../src/utils/model/agentModelPicker.js')
  const { ANTHROPIC_MODEL_GROUP, MODES_MODEL_GROUP, isProviderActionRow } = await import('../../src/utils/model/modelOptions.js')
  const { isHaikuTier } = await import('../../src/utils/model/modelFloor.js')
  // The injected fixture catalogue: every row class the owner can emit, in
  // an order the derivation must PRESERVE (the neutrality law is
  // structural — the catalogue's own grammar, never editorial). TYPED as
  // ModelOption[] — the AGENTVERIFY census found the old `as never` cast
  // let a shape drift ride unchecked.
  // Model rows carry EMPTY descriptions (the neutrality ruling)
  // — the one operator-copy exception is the env custom row,
  // whose description is the operator's own passthrough.
  const fixture: import('../../src/utils/model/modelOptions.ts').ModelOption[] = [
    { value: null, label: 'Default', description: 'Default (Fable 5)' },
    { value: '__mercury_anthropic_connect__', label: 'Claude — sign in', description: '↵ runs /logins anthropic' },
    { value: 'fable', label: 'Fable', description: '' },
    { value: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)', description: '' },
    { value: 'haiku', label: 'Haiku', description: '' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: '' },
    { value: 'my-custom-model', label: 'Custom', description: 'operator copy (ANTHROPIC_CUSTOM_MODEL_OPTION passthrough, no group)' },
    { value: '__scribe_router__', label: 'Scribe', description: 'two-stream router', group: MODES_MODEL_GROUP },
    { value: '__scribe_router_workflows__', label: 'Scribe router (workflows)', description: 'workflow seats', group: MODES_MODEL_GROUP },
    { value: 'gpt-6.2', label: 'GPT-6.2', description: '', group: 'Mercury — OpenAI models', unavailable: 'no OpenAI account connected' },
    { value: '__mercury_connect__:zai', label: 'Z.AI — attach a key', description: '↵ opens /logins zai', group: 'Mercury — Z.AI models' },
    { value: 'glm-5.3', label: 'GLM-5.3', description: '', group: 'Mercury — Z.AI models', unavailable: 'no API key attached' },
    { value: 'openrouter/qwen/qwen3-coder', label: 'qwen3-coder', description: '', group: 'Mercury — OpenRouter models', statedContextWindow: 262144 },
    { value: 'compat/qwen3', label: 'qwen3', description: '', group: 'Mercury — custom endpoint' },
  ]
  const rows = getAgentModelPickerRows(fixture)
  t.check('inherit leads — the agent grammar\'s own default row', rows[0]?.kind === 'inherit' && rows[0]?.value === 'inherit')
  // THE SET-DIFFERENCE TOTALITY LAW (AGENTVERIFY A1): the expected list is
  // COMPUTED from the exclusion OWNERS (the null pseudo-row · the MODES
  // group constant · the floor's own predicate), never hand-enumerated —
  // so the pin red-lines if the derivation ever grows a fourth exclusion,
  // drops one, or re-spells a class by literal. Order = the catalogue's own.
  const expected = fixture.filter(
    (opt): opt is typeof opt & { value: string } =>
      opt.value !== null && opt.group !== MODES_MODEL_GROUP && !isHaikuTier(opt.value),
  )
  t.check(
    'TOTALITY: picker rows ≡ catalogue minus EXACTLY {null · MODES · haiku-tier}, order preserved',
    JSON.stringify(rows.slice(1).map(r => r.value)) === JSON.stringify(expected.map(o => o.value)),
    rows.map(r => r.value).join(' · '),
  )
  t.check(
    'TOTALITY, row-wise: kind by the action-row owner · group by the catalogue paint law · unavailable/label/description carried byte-equal',
    expected.every((opt, i) => {
      const row = rows[i + 1]!
      return (
        row.kind === (isProviderActionRow(opt.value) ? 'connect' : 'model') &&
        row.group === (opt.group ?? ANTHROPIC_MODEL_GROUP) &&
        row.unavailable === opt.unavailable &&
        row.label === opt.label &&
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
  // The haiku-SLOT env-pin fold at the picker face (the A1 predicate fix's
  // consequence here): a catalogue row carrying the PIN VALUE is the haiku
  // tier in the operator's own spelling — excluded like every other
  // spelling of it.
  {
    const priorPin = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'fastcheap-gw-v1'
    try {
      const pinned = getAgentModelPickerRows([
        { value: 'fastcheap-gw-v1', label: 'Ops haiku', description: 'gateway spelling of the haiku slot' },
        { value: 'claude-opus-5', label: 'Opus 5', description: 'large' },
      ])
      t.check(
        'a row valued as the haiku-slot PIN is excluded (the alias resolves to that string at dispatch)',
        JSON.stringify(pinned.slice(1).map(r => r.value)) === JSON.stringify(['claude-opus-5']),
        pinned.map(r => r.value).join(' · '),
      )
    } finally {
      if (priorPin === undefined) delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = priorPin
    }
  }
  // The ONE pick adjudication both skins share.
  t.check('picking a live model commits its value', JSON.stringify(agentModelPickOutcome(rows.find(r => r.value === 'compat/qwen3')!)) === '{"kind":"picked","model":"compat/qwen3"}')
  t.check('picking inherit commits the ABSENT field', JSON.stringify(agentModelPickOutcome(rows[0]!)) === '{"kind":"picked"}')
  t.check('picking an unavailable model routes to sign-in with its reason', agentModelPickOutcome(rows.find(r => r.value === 'gpt-6.2')!).kind === 'needs-sign-in')
  t.check('picking a connect row routes to sign-in', agentModelPickOutcome(rows.find(r => r.value === '__mercury_connect__:zai')!).kind === 'needs-sign-in')

  // THE OFFERED⇔DISPATCHABLE IDENTITY (AGENTVERIFY A2): every 'model'-kind
  // row genuinely dispatches — resolution may expand an alias (that is
  // resolution, not rewrite) but the floor NEVER fires on an offered row;
  // the excluded haiku spellings are exactly the floored class; a sentinel
  // saved by hand never lands a family silently (unrecognised — the
  // home-lane admission refuses before any wire).
  {
    const { getAgentModelWithFloorNote } = await import('../../src/utils/model/agent.js')
    const { classifyModelRoute } = await import('../../src/services/providers/routeLaw.js')
    const PARENT = 'claude-opus-5'
    t.check(
      'every offered model row dispatches UN-floored and deterministically',
      rows
        .filter(r => r.kind === 'model')
        .every(r => {
          const note = getAgentModelWithFloorNote(r.value, PARENT)
          return note.flooredFrom === undefined && note.model.length > 0
        }),
    )
    t.check(
      'the excluded haiku spellings are exactly the floored class',
      ['haiku', 'claude-haiku-4-5-20251001'].every(
        v => isHaikuTier(v) && getAgentModelWithFloorNote(v, PARENT).flooredFrom !== undefined,
      ),
    )
    t.check(
      'a hand-saved sentinel never lands a family silently (unrecognised, refused at admission)',
      ['__scribe_router__', '__mercury_connect__:zai'].every(
        v => classifyModelRoute(getAgentModelWithFloorNote(v, PARENT).model).kind === 'unrecognised',
      ),
    )
  }

  // Neutrality, structural: the derivation module names no family literal
  // (haiku is excluded by the floor's own PREDICATE, never by spelling).
  const pickerSrc = readFileSync(join(repoRoot, 'src/utils/model/agentModelPicker.ts'), 'utf-8')
  const code = pickerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  t.check('the derivation names no family literal (neutral by construction)', !/['"](?:opus|sonnet|fable|haiku|gpt|gemini|kimi|glm)['"]/.test(code))
  // AGENTVERIFY A4 — the same law over the SURFACES: the two skins' pick
  // composition and the machine speak no family either (equal is
  // structural everywhere the rows travel, not only at the derivation).
  for (const surface of [
    'src/components/agents/ModelSelector.tsx',
    'src/components/BootAgentsScreen.tsx',
    'src/components/agents/studio/studioEditorModel.ts',
  ]) {
    const src = readFileSync(join(repoRoot, surface), 'utf-8')
    const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    t.check(
      `no family literal on the surface: ${surface.split('/').pop()}`,
      !/['"](?:opus|sonnet|fable|haiku|mythos|gpt|gemini|kimi|glm|deepseek|qwen)['"]/.test(stripped),
    )
  }

  // R1 — the one-home retirement census, both directions.
  const agentTsSrc = readFileSync(join(repoRoot, 'src/utils/model/agent.ts'), 'utf-8')
  t.check('getAgentModelOptions is RETIRED (the comment stands where the function stood)', !agentTsSrc.includes('export function getAgentModelOptions'))
  const studioSrc = readFileSync(join(repoRoot, 'src/components/agents/studio/AgentStudio.tsx'), 'utf-8')
  t.check("the inspector's hard family cycle is DEAD", !studioSrc.includes("['opus', 'sonnet', 'fable']"))
  const selectorSrc = readFileSync(join(repoRoot, 'src/components/agents/ModelSelector.tsx'), 'utf-8')
  t.check("the '?? sonnet' default is DEAD (inherit is the highlight fallback)", !selectorSrc.includes("?? 'sonnet'") && selectorSrc.includes("?? 'inherit'"))
  t.check('both skins consume THE ONE derivation', selectorSrc.includes('getAgentModelPickerRows') && readFileSync(join(repoRoot, 'src/components/BootAgentsScreen.tsx'), 'utf-8').includes('getAgentModelPickerRows'))
  const editorSrc = readFileSync(join(repoRoot, 'src/components/agents/studio/StudioEditor.tsx'), 'utf-8')
  t.check('the effort preview follows the PARENT model, never a hardcoded family', !editorSrc.includes("'claude-fable-5'") && editorSrc.includes('props.parentModel'))

  // R2 — the layer swap's return law (agents → logins → back, state intact).
  const faceSrc2 = readFileSync(join(repoRoot, 'src/components/BootAgentsScreen.tsx'), 'utf-8')
  const splashSrc2 = readFileSync(join(repoRoot, 'src/components/BootSplashScreen.tsx'), 'utf-8')
  t.check('the agents layer suspends whole (renders nothing, lists parked) while the sign-in door is open', faceSrc2.includes('if (suspended) return null;') && faceSrc2.includes('!suspended && formPick !== null'))
  t.check('the host keeps the agents layer MOUNTED beneath its Logins layer and returns to it', splashSrc2.includes('suspended={loginsOpen}') && splashSrc2.includes('onOpenLogins={() => setLoginsOpen(true)}'))
  t.check('the return re-derives a live model pick (a sign-in moved the presence — never the captured rows)', faceSrc2.includes('wasSuspended.current && !suspended'))
  t.check('the chat skin names the sign-in door on the note (the draft is never abandoned)', selectorSrc.includes('/logins opens the sign-in catalogue'))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§7 — THE FRONTIER PASS (the authoring guidance · the availability truth · the field totality)')
{
  // The drafting guidance carries the live prompting doc's laws (fetched
  // and distilled at C6 — checked-in words, never a runtime fetch).
  const genSrc = readFileSync(join(repoRoot, 'src/components/agents/generateAgent.ts'), 'utf-8')
  for (const law of [
    'SHORT set of principles, not an enumeration',
    'the reason beside the rule',
    'ending on a promise',
    'tool-result',
    'echo, transcribe or explain the agent',
    'lead with the outcome in complete sentences',
  ]) {
    t.check(`the drafting guidance carries: "${law.slice(0, 40)}"`, genSrc.includes(law), law)
  }
  t.check('the over-prescription clause is DEAD (comprehensive-behaviours-with-edge-cases)', !genSrc.includes('Comprehensive behavioural instructions'))

  // The availability note — a session fact worn, never a validation error.
  const { agentModelAvailabilityNote, getAgentModelPickerRows } = await import('../../src/utils/model/agentModelPicker.js')
  const rows = getAgentModelPickerRows([
    { value: 'fable', label: 'Fable', description: '' },
    { value: 'gpt-6.2', label: 'GPT-6.2', description: '', group: 'Mercury — OpenAI models', unavailable: 'no OpenAI account connected' },
  ] as never)
  t.check('inherit/absent wears nothing', agentModelAvailabilityNote(undefined, rows) === null && agentModelAvailabilityNote('inherit', rows) === null)
  t.check('an unavailable saved model wears its reason', agentModelAvailabilityNote('gpt-6.2', rows) === 'no OpenAI account connected')
  t.check('an available model wears nothing', agentModelAvailabilityNote('fable', rows) === null)
  t.check('an id the catalogue does not know wears nothing (unknown ≠ unavailable)', agentModelAvailabilityNote('compat/mystery', rows) === null)
  const editorSrc2 = readFileSync(join(repoRoot, 'src/components/agents/studio/StudioEditor.tsx'), 'utf-8')
  const studioSrc2 = readFileSync(join(repoRoot, 'src/components/agents/studio/AgentStudio.tsx'), 'utf-8')
  const faceSrc3 = readFileSync(join(repoRoot, 'src/components/BootAgentsScreen.tsx'), 'utf-8')
  t.check('the chat review wears it', editorSrc2.includes('agentModelAvailabilityNote(doc.fields.model)'))
  t.check('the chat inspector wears it', studioSrc2.includes('agentModelAvailabilityNote(agent.operatorOverride?.model ?? agent.model)'))
  t.check('the face dossier and form wear it', faceSrc3.includes('availabilityNote: string | null = null') && faceSrc3.includes('agentModelAvailabilityNote(snap.doc.fields.model)'))
  // AGENTVERIFY A9: the form's `runs:` line claims dispatch truth — it must
  // ride the resolved runtime (intent → resolved, floor named), never the
  // raw draft intent (the dossier and chat review already do; a form line
  // painting 'haiku' while dispatch runs the floor's fallback would lie).
  t.check(
    "the face FORM's runs: line rides the resolved runtime with the floor named",
    faceSrc3.includes('effectiveStudioRuntime({') &&
      faceSrc3.includes('${effRun.modelIntent} → ${effRun.model}') &&
      faceSrc3.includes('floored from ${effRun.flooredFrom}'),
  )
  t.check("availability never joins the save gate (the machine's validation is availability-blind)", !modelSrc.includes('agentModelAvailabilityNote'))
  // AGENTVERIFY A8 — the born-held save DRIVEN, not needled: a definition
  // whose model is unavailable THIS session saves whole; the reason is worn
  // at the surfaces (above), never raised at the gate.
  {
    const { decodeAgentDocument: decode } = await import('../../src/services/agents/codec.js')
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

  // THE FIELD TOTALITY (the capability re-census, mechanical): the form's
  // rows cover every KNOWN frontmatter key except exactly the three
  // preserved-as-is keys; the document body rides as its own row.
  const { FIELD_ROWS: fieldRows } = await import('../../src/components/agents/studio/studioEditorModel.js')
  const { KNOWN_AGENT_KEYS } = await import('../../src/services/agents/contracts.js')
  const preserved = new Set(['mcpServers', 'hooks', 'spec-version'])
  const formKeys = new Set(fieldRows.map(r => r.id).filter(id => id !== 'body'))
  const contractKeys = new Set(KNOWN_AGENT_KEYS.filter(k => !preserved.has(k)))
  t.check(
    'the form covers the WHOLE agent contract minus the three preserved-as-is keys',
    formKeys.size === contractKeys.size && [...contractKeys].every(k => formKeys.has(k)),
    `form=${[...formKeys].join(',')} vs contract=${[...contractKeys].join(',')}`,
  )
  t.check("the body rides as the form's own row", fieldRows.some(r => r.id === 'body'))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§8 — THE SIGN-IN WALK, DRIVEN (AGENTVERIFY A3: the face swap on a live mount, never needles alone)')
{
  // The receipt's R2 evidence was source needles; this drives the road: a
  // real ink mount over in-process streams (no PTY), keys through the
  // renderer's readable/read stdin contract, the sign-in door picked
  // mid-form, the layer suspending whole, the presence flipped in the
  // scratch world, the return re-deriving the rows into the SAME open pick.
  // Hermetic by construction: navigation indexes and row counts are
  // computed at runtime from the SAME derivation the component calls, and
  // the flipped presence is the zai key lane — env-scoped (ZAI_API_KEY),
  // scratch-config-scoped, no keychain rung.
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const stripAnsi = (await import('strip-ansi')).default
  const React = (await import('react')).default
  const { render } = await import('../../src/ink.js')
  const { BootAgentsScreen, agentFormRowIds } = await import('../../src/components/BootAgentsScreen.js')
  const { getAgentModelPickerRows } = await import('../../src/utils/model/agentModelPicker.js')
  const { keyConnectValue } = await import('../../src/utils/model/modelOptions.js')

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
    await settle(90)
    t.check('the library mounts under keys', frameText().includes('n new'))

    // n → the form; walk to the model row by the form's OWN row order.
    const modelRowIdx = agentFormRowIds('create').indexOf('model')
    await press('n')
    for (let i = 0; i < modelRowIdx; i++) await press(DOWN)
    output = ''
    await press('\r')
    const pickFrame = frameText()
    t.check('↵ on the model row opens the full-catalogue pick', pickFrame.includes(`${staleRows.length} rows — the full catalogue`), pickFrame.slice(-200))

    // Navigate to the zai connect door (index computed, never hardcoded) → ↵.
    for (let i = 0; i < zaiConnectIdx; i++) await press(DOWN)
    output = ''
    await press('\r')
    await settle(70)
    t.check('↵ on the connect door fires the host swap exactly once', hostControl.openedCount === 1)
    t.check(
      'suspended, the agents layer renders NOTHING (the host owns the paint)',
      !frameText().includes('the full catalogue') && !frameText().includes('CONTROL PLANE'),
    )

    // The sign-in: the zai key arrives while the layer is parked.
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

    // esc closes the pick — the form beneath survived the whole swap.
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

// ────────────────────────────────────────────────────────────────────────────
t.section('§9 — THE BUILT-IN MODEL DIAL (AGENTDIALS C1: the override round-trip · dispatch wears it · inherit clears · the face walk)')
{
  // The ruled shape: a per-agent model override stored in CONFIG (the
  // agent-overrides settings row, user scope — built-ins stay code-defined,
  // "built-in (no file)" stays true); ↵ on a built-in row opens a
  // MODEL-ONLY pick riding the ONE catalogue derivation; 'Inherit' clears;
  // DISPATCH inherits with zero new surface (the loader patches the
  // definition, the spawn chokepoint resolves definition.model through the
  // landed floor/admission predicates).
  const { setAgentOverride, userOverridesPath } = await import('../../src/services/agents/overrides.js')
  const { clearAgentDefinitionsCache, getAgentDefinitionsWithOverrides } = await import(
    '../../src/tools/AgentTool/loadAgentsDir.js'
  )
  const { buildStudioRows } = await import('../../src/components/agents/studio/studioData.js')
  const { getAgentModel } = await import('../../src/utils/model/agent.js')
  const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.js')
  const { resolveEffectiveAgentRuntime } = await import('../../src/services/agents/resolver.js')
  const { agentFaceDetailLines, BootAgentsScreen } = await import('../../src/components/BootAgentsScreen.js')
  const { getAgentModelPickerRows } = await import('../../src/utils/model/agentModelPicker.js')

  const walkCwd = mkdtempSync(join(tmpdir(), 'agent-dial-walk-'))

  // ── the pure round-trip: set · the loader patches · dispatch wears · clear
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
    getAgentModel(worn?.model, 'claude-fable-5') === parseUserSpecifiedModel('fixture-dial/model-x'),
  )
  await setAgentOverride('user', walkCwd, firstType, undefined)
  clearAgentDefinitionsCache()
  const defs2 = await getAgentDefinitionsWithOverrides(walkCwd)
  const clearedDef = defs2.allAgents.find(a => a.agentType === firstType)
  t.check('inherit CLEARS: the definition reads code-declared again, provenance gone', clearedDef?.operatorOverride === undefined && (clearedDef?.model ?? 'inherit') === 'inherit')

  // ── the LEGIBLE inherit line (the detail panel names the mechanism)
  const effInherit = resolveEffectiveAgentRuntime(clearedDef as never, { parentModel: 'claude-fable-5', sessionEffort: undefined })
  const detail = agentFaceDetailLines({ id: `agent:${firstType}`, kind: 'agent', agent: clearedDef } as never, new Map(), effInherit)
  t.check(
    "inherit reads LEGIBLY: 'inherit → <resolved> (your session's model)' — never an Anthropic tie",
    detail.some(l => l.includes('model: inherit → claude-fable-5') && l.includes("(your session's model)")),
    detail.find(l => l.startsWith('model:')) ?? '(no model line)',
  )

  // ── source law: the door routes built-ins to the dial; the store write is
  //    user-scope config; the R2 return re-derives the dial's rows; the
  //    catalogue-neutrality ratchet holds (zero family literals in the face).
  const faceSrc9 = readFileSync(join(repoRoot, 'src/components/BootAgentsScreen.tsx'), 'utf-8')
  t.check('↵ routes a built-in row to the model dial BEFORE the clone-first refusal (which non-file rows keep)', faceSrc9.indexOf("r.agent.source === 'built-in'") > 0 && faceSrc9.indexOf("r.agent.source === 'built-in'") < faceSrc9.indexOf('only file-backed agents edit here'))
  t.check('the pick commits through the config settings row (user scope), never a file write', faceSrc9.includes("setAgentOverride(\n              'user',"))
  t.check('the R2 return re-derives the dial rows (a sign-in moved the presence)', faceSrc9.includes('setModelPick(pick => (pick !== null ? { ...pick, rows: getAgentModelPickerRows() } : pick))'))
  const faceCode9 = faceSrc9.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/([^:'"`])\/\/[^\n]*/g, '$1')
  t.check('catalogue-neutrality ratchet: ZERO family literals in the face (the rows derive, never spell)', !/['"`](claude-|sonnet|opus|haiku|fable|mythos|gpt-|glm-)/i.test(faceCode9))

  // ── THE FACE WALK, DRIVEN (the §8 harness): ↵ on a built-in row opens the
  //    model-only pick; an available pick lands the config row and the list
  //    wears (override); ↵ then Inherit clears it; an unavailable row is a
  //    sign-in door (the note names /logins on a host with no Logins layer).
  const priorZai9 = process.env.ZAI_API_KEY
  process.env.ZAI_API_KEY = 'zai-fixture-key-for-the-dial-walk'
  try {
    const { EventEmitter } = await import('node:events')
    const { PassThrough } = await import('node:stream')
    const stripAnsi = (await import('strip-ansi')).default
    const React = (await import('react')).default
    const { render } = await import('../../src/ink.js')
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
    // The commit is a durable write THEN an async loader reload — assert by
    // arrival, never a fixed sleep (the harness's own count law).
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
    // The list keeps its index across the reopen (the landed hook idiom) —
    // walk UP to the top row: Inherit, the clear (UP clamps at 0).
    const UP = `${ESC}[A`
    for (let i = 0; i < targetIdx; i++) await press(UP)
    output = ''
    await press('\r') // row 0 = Inherit — the clear
    const fileCleared = await waitUntil(() => {
      try {
        return !readFileSync(userOverridesPath(), 'utf-8').includes(targetValue)
      } catch {
        return false
      }
    })
    // The wear check needs a FRESH frame (the output buffer accumulates, so
    // a pre-clear paint would satisfy a stale positive and poison a
    // negative forever): reset, nudge a selection repaint, assert on what
    // arrives after the clear alone.
    output = ''
    await press(DOWN)
    const wearGone = await waitUntil(() => frameText().includes(firstType) && !frameText().includes('(override)'))
    t.check('Inherit CLEARS the config row and the wear', fileCleared && wearGone, `file=${readFileSync(userOverridesPath(), 'utf-8').replace(/\s+/g, ' ').slice(0, 120)}`)

    const unavailIdx = dialRows.findIndex(r => r.kind === 'model' && r.unavailable !== undefined)
    if (unavailIdx > 0) {
      output = ''
      await press('\r')
      await waitUntil(() => frameText().includes('model override'))
      // The reopen keeps the last index (0 after the clear) — walk DOWN to
      // the unavailable row from the top.
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

t.finish('prove-agent-face')
