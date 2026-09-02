// ============================================================================
//  studioEditorModel — THE ONE AGENT FORM MACHINE (the
//  anthropicLoginModel / sessionPickerModel extraction precedent).
//
//  The machine owns the draft (an AgentDocument — the lossless codec form),
//  every transition and every spelling: patch-through-codec (fail-closed),
//  the validation the review paints AND the save gate enforces, the
//  saveAgentDocument road with its revision-conflict arm and the
//  merge-onto-theirs re-apply, draft autosave/recover/discard, the guided
//  flow's stable step ids + explicit history, generation, and the note
//  vocabulary. React-free with injected seams (store · fs · generation ·
//  timers) so provers walk it whole with fakes and hand-driven beats.
//
//  The SKINS render and map keys — nothing else: the Ink StudioEditor
//  (/agents in-chat, byte-preserved across this extraction) and the Boot
//  face's agents layer are two skins over THIS machine. Identity is pinned
//  both directions by prove-agent-face §1–§2: the spellings live here, the
//  skins retain none.
// ============================================================================
import { structuredPatch } from 'diff'
import { readFileSync } from 'node:fs'
import {
  decodeAgentDocument,
  patchAgentDocument,
  serializeAgentMarkdown,
} from '../../../services/agents/codec.js'
import {
  AgentCodecPatchError,
  type AgentDocument,
  type AgentFileIdentity,
  type AgentSpecFields,
  revisionDigest,
} from '../../../services/agents/contracts.js'
import { resolveEffectiveAgentRuntime } from '../../../services/agents/resolver.js'
import {
  AgentStoreError,
  discardAgentDraft,
  listAgentDrafts,
  newAgentPath,
  saveAgentDocument,
  saveAgentDraft,
  validateAgentIdentifier,
} from '../../../services/agents/store.js'
import type { Tools } from '../../../Tool.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '../../../tools/AgentTool/loadAgentsDir.js'
import type { EffortValue } from '../../../utils/effort.js'
import { AMBER, CRIMSON, SECOND, TEAL } from '../../mercuryPalette.js'
import { truncateToWidth } from '../../mercury-ui/glyphs.js'
import type { generateAgent } from '../generateAgent.js'

// ── vocabulary ──────────────────────────────────────────────────────────────

export type StudioDraftBase = {
  identity: AgentFileIdentity
  agent: AgentDefinition
}

export type GuidedStep =
  | 'destination'
  | 'method'
  | 'describe'
  | 'identity'
  | 'prompt'
  | 'description'
  | 'tools'
  | 'model'
  | 'review'

export type FieldId =
  | 'name'
  | 'description'
  | 'body'
  | 'tools'
  | 'disallowedTools'
  | 'skills'
  | 'model'
  | 'effort'
  | 'permissionMode'
  | 'maxTurns'
  | 'memory'
  | 'background'
  | 'isolation'
  | 'initialPrompt'
  | 'instructionProfile'
  | 'color'

export type EditorView =
  | { kind: 'guided'; step: GuidedStep; history: GuidedStep[] }
  | { kind: 'advanced'; cursor: number; editing: FieldId | null }
  | { kind: 'raw' }
  | { kind: 'review' }

export const FIELD_ROWS: { id: FieldId; label: string }[] = [
  { id: 'name', label: 'identifier' },
  { id: 'description', label: 'description' },
  { id: 'body', label: 'system prompt' },
  { id: 'tools', label: 'tools' },
  { id: 'disallowedTools', label: 'disallowed tools' },
  { id: 'skills', label: 'skills' },
  { id: 'model', label: 'model' },
  { id: 'effort', label: 'effort' },
  { id: 'permissionMode', label: 'permission mode' },
  { id: 'maxTurns', label: 'max turns' },
  { id: 'memory', label: 'memory' },
  { id: 'background', label: 'background' },
  { id: 'isolation', label: 'isolation' },
  { id: 'initialPrompt', label: 'initial prompt' },
  { id: 'instructionProfile', label: 'instruction profile' },
  { id: 'color', label: 'color' },
]

export type StudioNote = { text: string; tone: string }

export type StudioValidation = {
  errors: string[]
  warnings: string[]
  canSave: boolean
}

// ── pure projections (shared by both skins and the provers) ─────────────────

export function freshStudioDocument(): AgentDocument {
  return decodeAgentDocument(
    serializeAgentMarkdown({ name: '', description: '' }, ''),
  )
}

export function fieldValueLabel(doc: AgentDocument, id: FieldId): string {
  const f = doc.fields
  switch (id) {
    case 'name':
      return f.name || '(required)'
    case 'description':
      return f.description ? truncateToWidth(f.description.replace(/\n/g, ' '), 40) : '(required)'
    case 'body':
      return doc.body.trim()
        ? `${doc.body.trim().split('\n')[0]?.slice(0, 36) ?? ''} · ${doc.body.trim().length} chars`
        : '(required)'
    case 'tools':
      return f.tools === undefined ? 'all tools' : f.tools.length === 0 ? 'none' : f.tools.join(', ')
    case 'disallowedTools':
      return f.disallowedTools?.join(', ') ?? '(none)'
    case 'skills':
      return f.skills?.join(', ') ?? '(none)'
    case 'model':
      return f.model ?? 'inherit'
    case 'effort':
      return f.effort !== undefined ? String(f.effort) : 'inherit session'
    case 'permissionMode':
      return f.permissionMode ?? '(default)'
    case 'maxTurns':
      return f.maxTurns !== undefined ? String(f.maxTurns) : '(unlimited)'
    case 'memory':
      return f.memory ?? '(off)'
    case 'background':
      return f.background ? 'always background' : '(model decides)'
    case 'isolation':
      return f.isolation ?? '(shared cwd)'
    case 'initialPrompt':
      return f.initialPrompt ? truncateToWidth(f.initialPrompt, 40) : '(none)'
    case 'instructionProfile':
      return f.instructionProfile ?? '(session default)'
    case 'color':
      return f.color ?? '(automatic)'
  }
}

/** The guided flow's explicit successor map — stable ids, never an index
 *  (the goToStep(3)/goToStep(6) class died with the old wizard). */
export function guidedNext(step: GuidedStep): GuidedStep {
  switch (step) {
    case 'destination':
      return 'method'
    case 'method':
      return 'identity' // generate path routes explicitly in its handler
    case 'describe':
      return 'review'
    case 'identity':
      return 'prompt'
    case 'prompt':
      return 'description'
    case 'description':
      return 'tools'
    case 'tools':
      return 'model'
    case 'model':
      return 'review'
    case 'review':
      return 'review'
  }
}

/** What a guided text step's buffer seeds from (entry-time, never live —
 *  reseeding on every doc edit would fight the operator's typing). */
export function guidedSeedFor(doc: AgentDocument, step: GuidedStep): string {
  return step === 'identity'
    ? doc.fields.name
    : step === 'prompt'
      ? doc.body.trim()
      : step === 'description'
        ? doc.fields.description
        : ''
}

/** The advanced text editors' seed per field (the openText initials). */
export function advancedFieldSeed(doc: AgentDocument, field: FieldId): string {
  return field === 'name'
    ? doc.fields.name
    : field === 'description'
      ? doc.fields.description
      : field === 'skills'
        ? (doc.fields.skills ?? []).join(', ')
        : field === 'maxTurns'
          ? doc.fields.maxTurns !== undefined
            ? String(doc.fields.maxTurns)
            : ''
          : doc.fields.initialPrompt ?? ''
}

/** The ONE validation — the review paints it and the save gate enforces it
 *  (the store re-checks; this is the displayed binding). */
export function computeStudioValidation(args: {
  doc: AgentDocument
  existingAgents: readonly AgentDefinition[]
  base: StudioDraftBase | undefined
  mode: 'create' | 'edit'
}): StudioValidation {
  const { doc, existingAgents, base, mode } = args
  const errors: string[] = []
  const warnings: string[] = []
  const idError = validateAgentIdentifier(doc.fields.name)
  if (idError) errors.push(idError)
  if (!doc.fields.description) errors.push('Description is required')
  else if (doc.fields.description.length < 10)
    warnings.push('Description should say when to delegate (≥10 chars)')
  if (!doc.body.trim()) errors.push('System prompt (body) is required')
  else if (doc.body.trim().length < 20)
    errors.push('System prompt is too short (minimum 20 characters)')
  for (const d of doc.diagnostics) {
    if (d.severity === 'error') errors.push(`${d.code}: ${d.message}`)
    else if (d.severity === 'warning') warnings.push(d.message)
  }
  const dupe = existingAgents.find(
    a =>
      a.agentType === doc.fields.name &&
      (base === undefined ||
        (a as CustomAgentDefinition).filePath !== base.identity.filePath),
  )
  if (dupe) {
    if (mode === 'create' && !base) {
      errors.push(
        `"${doc.fields.name}" already exists (${dupe.source}) — pick another identifier or edit that one`,
      )
    } else {
      warnings.push(`"${doc.fields.name}" also exists in ${dupe.source} — precedence decides the winner`)
    }
  }
  return { errors, warnings, canSave: errors.length === 0 }
}

/** Where the draft lands (the header's arrow + the save target's path). */
export function studioDestinationPath(args: {
  base: StudioDraftBase | undefined
  scope: 'user' | 'project'
  cwd: string
  name: string
}): string {
  return args.base
    ? args.base.identity.filePath
    : newAgentPath(args.scope, args.cwd, args.name || '<identifier>')
}

/** The draft's effective runtime — a synthetic definition over the live
 *  resolver, exactly what a save would produce. */
export function effectiveStudioRuntime(args: {
  doc: AgentDocument
  base: StudioDraftBase | undefined
  scope: 'user' | 'project'
  parentModel: string
  sessionEffort: EffortValue | undefined
  tools: Tools
}): ReturnType<typeof resolveEffectiveAgentRuntime> {
  const { doc, base, scope } = args
  const synthetic: CustomAgentDefinition = {
    agentType: doc.fields.name || 'draft',
    whenToUse: doc.fields.description,
    ...(doc.fields.tools !== undefined ? { tools: doc.fields.tools } : {}),
    ...(doc.fields.disallowedTools !== undefined
      ? { disallowedTools: doc.fields.disallowedTools }
      : {}),
    ...(doc.fields.model !== undefined ? { model: doc.fields.model } : {}),
    ...(doc.fields.effort !== undefined ? { effort: doc.fields.effort } : {}),
    getSystemPrompt: () => doc.body,
    source: base?.agent.source ?? (scope === 'user' ? 'userSettings' : 'projectSettings'),
  } as CustomAgentDefinition
  return resolveEffectiveAgentRuntime(synthetic, {
    parentModel: args.parentModel,
    sessionEffort: args.sessionEffort,
    tools: args.tools,
  })
}

export type StudioReviewFacts = {
  /** Field keys whose value differs from the base file's current bytes. */
  changed: string[]
  /** Up to ten unified-diff lines, one-line context. */
  diffLines: string[]
}

/** The review pane's facts: base-file re-read (fail-soft to empty) + the
 *  changed-key census + the bounded diff. */
export function buildReviewFacts(
  doc: AgentDocument,
  base: StudioDraftBase | undefined,
  readFile: (path: string) => string = path => readFileSync(path, 'utf-8'),
): StudioReviewFacts {
  const beforeRaw = base
    ? (() => {
        try {
          return readFile(base.identity.filePath)
        } catch {
          return ''
        }
      })()
    : ''
  const beforeFields = base
    ? decodeAgentDocument(beforeRaw).fields
    : ({} as Partial<AgentSpecFields>)
  const changed: string[] = []
  const keys = new Set([
    ...Object.keys(beforeFields),
    ...Object.keys(doc.fields),
  ]) as Set<keyof AgentSpecFields>
  for (const k of keys) {
    if (JSON.stringify(beforeFields[k]) !== JSON.stringify(doc.fields[k])) {
      changed.push(String(k))
    }
  }
  const patch = structuredPatch('before', 'after', beforeRaw, doc.raw, undefined, undefined, { context: 1 })
  const diffLines = patch.hunks.flatMap(h => h.lines).slice(0, 10)
  return { changed, diffLines }
}

// ── the machine ─────────────────────────────────────────────────────────────

export interface StudioEditorSnapshot {
  doc: AgentDocument
  baseRevision: string | undefined
  scope: 'user' | 'project'
  view: EditorView
  note: StudioNote | null
  busy: boolean
  conflict: { currentRaw: string } | null
  recoverOffer: { path: string; raw: string } | null
  textBuffer: string
  textCursor: number
}

export interface StudioEditorDeps {
  readFile: (path: string) => string
  saveDocument: typeof saveAgentDocument
  saveDraft: typeof saveAgentDraft
  listDrafts: typeof listAgentDrafts
  discardDraft: typeof discardAgentDraft
  generate: typeof generateAgent
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

function liveDeps(): StudioEditorDeps {
  return {
    readFile: path => readFileSync(path, 'utf-8'),
    saveDocument: saveAgentDocument,
    saveDraft: saveAgentDraft,
    listDrafts: listAgentDrafts,
    discardDraft: discardAgentDraft,
    // Lazy on purpose (the modelFloor cycle precedent): generation pulls the
    // provider router stack, which must never join this module's static
    // graph — the machine also serves the Boot face's mount path.
    generate: async (prompt, model, existingIdentifiers, signal) =>
      (await import('../generateAgent.js')).generateAgent(prompt, model, existingIdentifiers, signal),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
  }
}

export interface StudioEditorOptions {
  mode: 'create' | 'edit'
  /** Editing: the exact discovered base. */
  base?: StudioDraftBase
  cwd: string
  /** Live reads (the skin's props move under the machine's feet). */
  getExistingAgents: () => readonly AgentDefinition[]
  getParentModel: () => string
  onSaved: (message: string) => void
  onCancel: () => void
}

/** The autosave debounce (the skin's landed 800ms). */
export const STUDIO_AUTOSAVE_DEBOUNCE_MS = 800

export interface StudioEditorMachine {
  snapshot(): StudioEditorSnapshot
  /** The draft mutation door — patch through the codec, fail-closed with
   *  the refusal spelling on the note. True on success. */
  commit(edit: Parameters<typeof patchAgentDocument>[1]): boolean
  /** Raw-view editor return: decode whole, diagnostics on the note. */
  loadRaw(content: string): void
  /** The advanced text editors' submit (parse rules + spellings). */
  commitTextField(field: FieldId, raw: string): void
  /** Advanced ↵ on a field row: seeds the text buffer where the field is
   *  text-edited, opens the editor either way. (The body/background/
   *  isolation rows never come here — the skin routes them.) */
  openFieldEditor(field: FieldId): void
  closeFieldEditor(): void
  /** Raw view-state moves (navigation; no rules live in the skin). */
  setView(view: EditorView): void
  setTextBuffer(value: string): void
  setTextCursor(offset: number): void
  /** The destination scope, bare (the face skin's destination row cycles it;
   *  the in-chat guided flow rides guidedDestination instead). */
  setScope(scope: 'user' | 'project'): void
  // The guided flow's semantic verbs (gates + spellings + successors).
  guidedDestination(scope: 'user' | 'project'): void
  guidedMethod(method: 'generate' | 'manual'): void
  guidedDescribe(prompt: string): void
  guidedIdentity(name: string): void
  guidedPrompt(body: string): void
  guidedDescription(description: string): void
  guidedTools(tools: string[] | undefined): void
  guidedModel(model?: string): void
  guidedBack(): void
  /** Review esc: create → the guided model step (history whole);
   *  edit → the advanced list. */
  reviewEscape(): void
  save(): Promise<void>
  mergeOntoTheirs(): void
  clearConflict(): void
  acceptRecover(): void
  declineRecover(): void
  /** True when a live generation was aborted (the skin's busy-esc). */
  abortGeneration(): boolean
  dispose(): void
}

export function createStudioEditorMachine(
  options: StudioEditorOptions,
  onChange: (snapshot: StudioEditorSnapshot) => void,
  injected?: Partial<StudioEditorDeps>,
): StudioEditorMachine {
  const deps: StudioEditorDeps = { ...liveDeps(), ...injected }
  const { mode, base, cwd } = options

  // ── the ONE draft ─────────────────────────────────────────────────────────
  let doc: AgentDocument = (() => {
    if (base) {
      // Re-read the EXACT discovered file so the draft starts from current
      // bytes (baseRevision is re-anchored below on success).
      try {
        return decodeAgentDocument(deps.readFile(base.identity.filePath), base.identity.filePath)
      } catch {
        return freshStudioDocument()
      }
    }
    return freshStudioDocument()
  })()
  let baseRevision: string | undefined = base ? revisionDigest(doc.raw) : undefined
  let scope: 'user' | 'project' = 'project'
  let view: EditorView =
    mode === 'create'
      ? { kind: 'guided', step: 'destination', history: [] }
      : { kind: 'advanced', cursor: 0, editing: null }
  let note: StudioNote | null = null
  let busy = false
  let conflict: { currentRaw: string } | null = null
  let textBuffer = ''
  let textCursor = 0
  // Draft recovery: offer a matching autosaved draft once, on entry.
  let recoverOffer: { path: string; raw: string } | null = (() => {
    const drafts = deps.listDrafts()
    const match = drafts.find(d =>
      base
        ? d.draft.baseIdentity?.filePath === base.identity.filePath
        : d.draft.baseIdentity === undefined,
    )
    return match ? { path: match.path, raw: match.draft.raw } : null
  })()

  let generationAbort: AbortController | null = null
  let autosaveTimer: unknown = null
  let disposed = false

  const emit = (): void => {
    if (!disposed) onChange(snapshot())
  }
  function snapshot(): StudioEditorSnapshot {
    return { doc, baseRevision, scope, view, note, busy, conflict, recoverOffer, textBuffer, textCursor }
  }

  // ── autosave (debounced; discarded on save and recover-decline) ──────────
  const armAutosave = (): void => {
    if (autosaveTimer !== null) deps.clearTimer(autosaveTimer)
    autosaveTimer = deps.setTimer(() => {
      autosaveTimer = null
      void deps
        .saveDraft({
          ...(base ? { baseIdentity: base.identity } : { newTarget: { scope, cwd } }),
          raw: doc.raw,
        })
        .catch(() => {})
    }, STUDIO_AUTOSAVE_DEBOUNCE_MS)
  }

  const discardDraftFile = (): void => {
    for (const d of deps.listDrafts()) {
      const matches = base
        ? d.draft.baseIdentity?.filePath === base.identity.filePath
        : d.draft.baseIdentity === undefined
      if (matches) deps.discardDraft(d.path)
    }
  }

  /** Every doc replacement is a dirty edit: swap + arm the autosave. */
  const adoptDoc = (next: AgentDocument): void => {
    doc = next
    armAutosave()
  }

  // ── the verbs ─────────────────────────────────────────────────────────────
  const commit = (edit: Parameters<typeof patchAgentDocument>[1]): boolean => {
    try {
      adoptDoc(patchAgentDocument(doc, edit))
      emit()
      return true
    } catch (e) {
      note = {
        text:
          e instanceof AgentCodecPatchError
            ? `edit refused: ${e.message}`
            : `edit failed: ${String(e)}`,
        tone: CRIMSON,
      }
      emit()
      return false
    }
  }

  const goStep = (from: GuidedStep, to: GuidedStep): void => {
    if (view.kind !== 'guided') return
    view = { kind: 'guided', step: to, history: [...view.history, from] }
    const seed = guidedSeedFor(doc, to)
    textBuffer = seed
    textCursor = seed.length
    emit()
  }

  const machine: StudioEditorMachine = {
    snapshot,
    commit,

    loadRaw(content) {
      if (content === doc.raw) return
      const next = decodeAgentDocument(content, base?.identity.filePath)
      adoptDoc(next)
      const errs = next.diagnostics.filter(d => d.severity === 'error')
      note =
        errs.length > 0
          ? { text: `raw edit loaded with ${errs.length} error(s) — fix before saving`, tone: AMBER }
          : { text: 'raw edit loaded', tone: TEAL }
      emit()
    },

    commitTextField(field, raw) {
      const value = raw.trim()
      let ok = false
      switch (field) {
        case 'name':
          ok = commit({ set: { name: value } })
          break
        case 'description':
          ok = commit({ set: { description: value } })
          break
        case 'skills':
          ok = commit({
            set: {
              skills: value
                ? value.split(',').map(s => s.trim()).filter(Boolean)
                : undefined,
            },
          })
          break
        case 'maxTurns': {
          if (value === '') ok = commit({ set: { maxTurns: undefined } })
          else {
            const n = Number(value)
            if (!Number.isInteger(n) || n <= 0) {
              note = { text: 'max turns must be a positive integer (empty clears)', tone: AMBER }
              emit()
              return
            }
            ok = commit({ set: { maxTurns: n } })
          }
          break
        }
        case 'initialPrompt':
          ok = commit({ set: { initialPrompt: value || undefined } })
          break
        default:
          return
      }
      if (ok && view.kind === 'advanced') {
        view = { ...view, editing: null }
        emit()
      }
    },

    openFieldEditor(field) {
      if (view.kind !== 'advanced') return
      if (
        field === 'name' ||
        field === 'description' ||
        field === 'skills' ||
        field === 'maxTurns' ||
        field === 'initialPrompt'
      ) {
        const seed = advancedFieldSeed(doc, field)
        textBuffer = seed
        textCursor = seed.length
      }
      view = { ...view, editing: field }
      emit()
    },

    closeFieldEditor() {
      if (view.kind !== 'advanced') return
      view = { ...view, editing: null }
      emit()
    },

    setView(next) {
      view = next
      emit()
    },
    setTextBuffer(value) {
      textBuffer = value
      emit()
    },
    setTextCursor(offset) {
      textCursor = offset
      emit()
    },
    setScope(next) {
      scope = next
      emit()
    },

    guidedDestination(next) {
      scope = next
      goStep('destination', 'method')
    },
    guidedMethod(method) {
      if (method === 'generate') goStep('method', 'describe')
      else goStep('method', 'identity')
    },
    guidedDescribe(prompt) {
      void runGeneration(prompt)
    },
    guidedIdentity(name) {
      const err = validateAgentIdentifier(name)
      if (err) {
        note = { text: err, tone: AMBER }
        emit()
        return
      }
      if (commit({ set: { name } })) goStep('identity', guidedNext('identity'))
    },
    guidedPrompt(body) {
      if (body.trim().length < 20) {
        note = { text: 'system prompt is too short (minimum 20 characters)', tone: AMBER }
        emit()
        return
      }
      if (commit({ body: body.trim() + '\n' })) goStep('prompt', guidedNext('prompt'))
    },
    guidedDescription(description) {
      if (!description.trim()) {
        note = { text: 'description is required — it tells Mercury when to delegate', tone: AMBER }
        emit()
        return
      }
      if (commit({ set: { description: description.trim() } })) goStep('description', guidedNext('description'))
    },
    guidedTools(tools) {
      if (commit({ set: { tools } })) goStep('tools', guidedNext('tools'))
    },
    guidedModel(model) {
      if (commit({ set: { model: model === 'inherit' ? undefined : model } })) {
        view = { kind: 'review' }
        emit()
      }
    },
    guidedBack() {
      if (view.kind !== 'guided') return
      const history = [...view.history]
      const prev = history.pop()
      if (!prev) {
        options.onCancel()
        return
      }
      view = { kind: 'guided', step: prev, history }
      const seed = guidedSeedFor(doc, prev)
      textBuffer = seed
      textCursor = seed.length
      emit()
    },

    reviewEscape() {
      if (mode === 'create') {
        view = {
          kind: 'guided',
          step: 'model',
          history: ['destination', 'method', 'identity', 'prompt', 'description', 'tools'],
        }
        const seed = guidedSeedFor(doc, 'model')
        textBuffer = seed
        textCursor = seed.length
      } else {
        view = { kind: 'advanced', cursor: 0, editing: null }
      }
      emit()
    },

    // ── save (the ONE binding: review gate ⇒ store gate) ────────────────────
    async save() {
      if (busy) return
      const validation = computeStudioValidation({
        doc,
        existingAgents: options.getExistingAgents(),
        base,
        mode,
      })
      if (!validation.canSave) {
        note = { text: 'fix the errors above before saving', tone: AMBER }
        emit()
        return
      }
      busy = true
      emit()
      try {
        const receipt = await deps.saveDocument(
          base
            ? {
                kind: 'existing',
                identity: {
                  filePath: base.identity.filePath,
                  revision: baseRevision ?? base.identity.revision,
                },
              }
            : { kind: 'new', scope, cwd, slug: doc.fields.name },
          doc,
        )
        discardDraftFile()
        options.onSaved(
          `${mode === 'create' ? 'Created' : 'Updated'} agent ${doc.fields.name} → ${receipt.path} (rev ${receipt.afterRevision}${receipt.semanticChanges.length > 0 ? `; changed: ${receipt.semanticChanges.join(', ')}` : ''})`,
        )
      } catch (e) {
        if (e instanceof AgentStoreError && e.code === 'revision-conflict') {
          conflict = { currentRaw: e.detail?.currentRaw ?? '' }
          note = {
            text: 'the file changed outside this draft — L loads theirs + re-applies your field edits · esc keeps editing',
            tone: AMBER,
          }
        } else {
          note = {
            text: e instanceof Error ? e.message : String(e),
            tone: CRIMSON,
          }
        }
      } finally {
        busy = false
        emit()
      }
    },

    // Conflict resolution: take THEIR bytes, re-apply MY changed fields + body.
    mergeOntoTheirs() {
      if (!conflict) return
      try {
        const theirs = decodeAgentDocument(conflict.currentRaw, base?.identity.filePath)
        const edits: Partial<AgentSpecFields> = {}
        for (const key of Object.keys(doc.fields) as (keyof AgentSpecFields)[]) {
          if (key === 'mcpServers' || key === 'hooks') continue
          if (JSON.stringify(doc.fields[key]) !== JSON.stringify(theirs.fields[key])) {
            // @ts-expect-error narrow per-key assignment over the shared union
            edits[key] = doc.fields[key]
          }
        }
        const merged = patchAgentDocument(theirs, {
          set: edits,
          ...(doc.body !== theirs.body ? { body: doc.body } : {}),
        })
        adoptDoc(merged)
        baseRevision = revisionDigest(conflict.currentRaw)
        conflict = null
        note = { text: 'their version loaded — your field edits re-applied on top; review and save again', tone: TEAL }
        emit()
      } catch (e) {
        note = { text: `merge failed: ${String(e)}`, tone: CRIMSON }
        emit()
      }
    },

    clearConflict() {
      conflict = null
      emit()
    },

    acceptRecover() {
      if (!recoverOffer) return
      try {
        const recovered = decodeAgentDocument(recoverOffer.raw, base?.identity.filePath)
        adoptDoc(recovered)
        note = { text: 'draft recovered — continuing where you left off', tone: TEAL }
        if (mode === 'create') view = { kind: 'advanced', cursor: 0, editing: null }
      } catch {
        note = { text: 'draft unreadable — starting fresh', tone: AMBER }
      }
      recoverOffer = null
      emit()
    },

    declineRecover() {
      if (!recoverOffer) return
      deps.discardDraft(recoverOffer.path)
      recoverOffer = null
      emit()
    },

    abortGeneration() {
      if (!generationAbort) return false
      generationAbort.abort()
      note = { text: 'generation cancelled', tone: AMBER }
      emit()
      return true
    },

    dispose() {
      disposed = true
      if (autosaveTimer !== null) deps.clearTimer(autosaveTimer)
      autosaveTimer = null
      generationAbort?.abort()
      generationAbort = null
    },
  }

  // ── generation ────────────────────────────────────────────────────────────
  async function runGeneration(prompt: string): Promise<void> {
    busy = true
    note = { text: 'generating agent from description …', tone: SECOND }
    emit()
    const controller = new AbortController()
    generationAbort = controller
    try {
      const generated = await deps.generate(
        prompt,
        options.getParentModel(),
        options.getExistingAgents().map(a => a.agentType),
        controller.signal,
      )
      adoptDoc(
        patchAgentDocument(doc, {
          set: { name: generated.identifier, description: generated.whenToUse },
          body: generated.systemPrompt.trim() + '\n',
        }),
      )
      note = { text: `generated "${generated.identifier}" — review it below`, tone: TEAL }
      view = { kind: 'review' }
    } catch (e) {
      note = {
        text: `generation failed: ${e instanceof Error ? e.message : String(e)} — edit the description and ↵ retries`,
        tone: CRIMSON,
      }
    } finally {
      busy = false
      generationAbort = null
      emit()
    }
  }

  return machine
}
