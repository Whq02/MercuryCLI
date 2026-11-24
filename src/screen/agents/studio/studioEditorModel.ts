import { structuredPatch } from 'diff'
import { readFileSync } from 'node:fs'
import {
  decodeAgentDocument,
  patchAgentDocument,
  serializeAgentMarkdown,
} from '../../../crew/agents/codec.js'
import {
  AgentCodecPatchError,
  type AgentDocument,
  type AgentFileIdentity,
  type AgentSpecFields,
  revisionDigest,
} from '../../../crew/agents/contracts.js'
import { resolveEffectiveAgentRuntime } from '../../../crew/agents/resolver.js'
import {
  AgentStoreError,
  discardAgentDraft,
  listAgentDraftsWithError,
  newAgentPath,
  saveAgentDocument,
  saveAgentDraft,
  validateAgentIdentifier,
} from '../../../crew/agents/store.js'
import type { Tools } from '../../../tools/kit/tool.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '../../../crew/agents/agentDefinition.js'
import type { EffortValue } from '../../../models/effort/effort.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { AMBER, CRIMSON, SECOND, TEAL } from '../../theme/mercuryPalette.js'
import { truncateToWidth } from '../../theme/glyphs.js'
import type { generateAgent } from '../generateAgent.js'
import { startTimeout, stopTimeout, type TimerHandle } from '../../../platform/async/timers.js'


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

type EditorView =
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

type StudioNote = { text: string; tone: string }

export type StudioValidation = {
  errors: string[]
  warnings: string[]
  canSave: boolean
}


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

export function guidedNext(step: GuidedStep): GuidedStep {
  switch (step) {
    case 'destination':
      return 'method'
    case 'method':
      return 'identity'
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

export function guidedSeedFor(doc: AgentDocument, step: GuidedStep): string {
  return step === 'identity'
    ? doc.fields.name
    : step === 'prompt'
      ? doc.body.trim()
      : step === 'description'
        ? doc.fields.description
        : ''
}

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

type StudioReviewFacts = {
  changed: string[]
  diffLines: string[]
}

export function buildReviewFacts(
  doc: AgentDocument,
  base: StudioDraftBase | undefined,
  readFile: (path: string) => string = path => readFileSync(path, 'utf-8'),
): StudioReviewFacts {
  let beforeRaw = ''
  if (base) {
    try {
      beforeRaw = readFile(base.identity.filePath)
    } catch (error) {
      logError(error)
      return {
        changed: ['(existing file unreadable)'],
        diffLines: [`Could not read existing agent file — check permissions before saving (${errorMessage(error)}).`],
      }
    }
  }
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

type DraftListResult = ReturnType<typeof listAgentDraftsWithError>

interface StudioEditorDeps {
  readFile: (path: string) => string
  saveDocument: typeof saveAgentDocument
  saveDraft: typeof saveAgentDraft
  listDrafts: () => DraftListResult['drafts'] | DraftListResult
  discardDraft: (path: string) => ReturnType<typeof discardAgentDraft> | void
  generate: typeof generateAgent
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
}

function unpackDraftList(result: ReturnType<StudioEditorDeps['listDrafts']>): DraftListResult {
  return Array.isArray(result) ? { drafts: result } : result
}

function discardDraftError(result: ReturnType<StudioEditorDeps['discardDraft']>): string | null {
  return result !== undefined && result.ok === false ? result.error : null
}

function liveDeps(): StudioEditorDeps {
  return {
    readFile: path => readFileSync(path, 'utf-8'),
    saveDocument: saveAgentDocument,
    saveDraft: saveAgentDraft,
    listDrafts: listAgentDraftsWithError,
    discardDraft: discardAgentDraft,
    generate: async (prompt, model, existingIdentifiers, signal) =>
      (await import('../generateAgent.js')).generateAgent(prompt, model, existingIdentifiers, signal),
    setTimer: (fn, ms) => startTimeout(fn, ms),
    clearTimer: handle => stopTimeout(handle),
  }
}

interface StudioEditorOptions {
  mode: 'create' | 'edit'
  base?: StudioDraftBase
  cwd: string
  getExistingAgents: () => readonly AgentDefinition[]
  getParentModel: () => string
  onSaved: (message: string) => void
  onCancel: () => void
}

const STUDIO_AUTOSAVE_DEBOUNCE_MS = 800

export interface StudioEditorMachine {
  snapshot(): StudioEditorSnapshot
  commit(edit: Parameters<typeof patchAgentDocument>[1]): boolean
  loadRaw(content: string): void
  commitTextField(field: FieldId, raw: string): void
  openFieldEditor(field: FieldId): void
  closeFieldEditor(): void
  setView(view: EditorView): void
  setTextBuffer(value: string): void
  setTextCursor(offset: number): void
  setScope(scope: 'user' | 'project'): void
  guidedDestination(scope: 'user' | 'project'): void
  guidedMethod(method: 'generate' | 'manual'): void
  guidedDescribe(prompt: string): void
  guidedIdentity(name: string): void
  guidedPrompt(body: string): void
  guidedDescription(description: string): void
  guidedTools(tools: string[] | undefined): void
  guidedModel(model?: string): void
  guidedBack(): void
  reviewEscape(): void
  save(): Promise<void>
  mergeOntoTheirs(): void
  clearConflict(): void
  acceptRecover(): void
  declineRecover(): void
  abortGeneration(): boolean
  dispose(): void
}

interface StudioEditorState {
  doc: AgentDocument
  baseDocument: AgentDocument
  baseRevision: string | undefined
  scope: 'user' | 'project'
  view: EditorView
  note: StudioNote | null
  busy: boolean
  conflict: { currentRaw: string } | null
  textBuffer: string
  textCursor: number
  recoverOffer: { path: string; raw: string } | null
  generationAbort: AbortController | null
  autosaveTimer: TimerHandle | null
  disposed: boolean
}

interface StudioEditorPorts {
  options: StudioEditorOptions
  deps: StudioEditorDeps
  mode: 'create' | 'edit'
  base: StudioDraftBase | undefined
  cwd: string
  onChange: (snapshot: StudioEditorSnapshot) => void
}

type StudioEditorCore = ReturnType<typeof studioEditorCore>

export function createStudioEditorMachine(
  options: StudioEditorOptions,
  onChange: (snapshot: StudioEditorSnapshot) => void,
  injected?: Partial<StudioEditorDeps>,
): StudioEditorMachine {
  const deps: StudioEditorDeps = { ...liveDeps(), ...injected }
  const { mode, base, cwd } = options
  const ports: StudioEditorPorts = { options, deps, mode, base, cwd, onChange }
  const state = studioEditorState(ports)
  const core = studioEditorCore(state, ports)
  return {
    snapshot: core.snapshot,
    commit: core.commit,
    ...studioFieldMethods(state, ports, core),
    ...studioGuidedMethods(state, ports, core),
    ...studioSaveMethods(state, ports, core),
    ...studioLifetimeMethods(state, ports, core),
  }
}

function studioEditorState({ deps, mode, base }: StudioEditorPorts): StudioEditorState {
  let baseReadError: string | undefined
  const doc: AgentDocument = (() => {
    if (base) {
      try {
        return decodeAgentDocument(deps.readFile(base.identity.filePath), base.identity.filePath)
      } catch (error) {
        logError(error)
        baseReadError = errorMessage(error)
        return freshStudioDocument()
      }
    }
    return freshStudioDocument()
  })()
  const draftList = unpackDraftList(deps.listDrafts())
  const match = draftList.drafts.find(d =>
    base
      ? d.draft.baseIdentity?.filePath === base.identity.filePath
      : d.draft.baseIdentity === undefined,
  )
  const note: StudioNote | null =
    baseReadError !== undefined
      ? { text: `Could not read existing agent file — check permissions before saving (${baseReadError}).`, tone: AMBER }
      : draftList.error !== undefined
        ? { text: `saved drafts could not be read (${draftList.error})`, tone: AMBER }
        : null
  return {
    doc,
    baseDocument: doc,
    baseRevision: base ? revisionDigest(doc.raw) : undefined,
    scope: 'project',
    view:
      mode === 'create'
        ? { kind: 'guided', step: 'destination', history: [] }
        : { kind: 'advanced', cursor: 0, editing: null },
    note,
    busy: false,
    conflict: null,
    textBuffer: '',
    textCursor: 0,
    recoverOffer: match ? { path: match.path, raw: match.draft.raw } : null,
    generationAbort: null,
    autosaveTimer: null,
    disposed: false,
  }
}

function studioEditorCore(state: StudioEditorState, { deps, base, cwd, onChange }: StudioEditorPorts) {
  const emit = (): void => {
    if (!state.disposed) onChange(snapshot())
  }
  function snapshot(): StudioEditorSnapshot {
    return {
      doc: state.doc,
      baseRevision: state.baseRevision,
      scope: state.scope,
      view: state.view,
      note: state.note,
      busy: state.busy,
      conflict: state.conflict,
      recoverOffer: state.recoverOffer,
      textBuffer: state.textBuffer,
      textCursor: state.textCursor,
    }
  }

  const armAutosave = (): void => {
    if (state.autosaveTimer !== null) deps.clearTimer(state.autosaveTimer)
    state.autosaveTimer = deps.setTimer(() => {
      state.autosaveTimer = null
      void deps
        .saveDraft({
          ...(base ? { baseIdentity: base.identity } : { newTarget: { scope: state.scope, cwd } }),
          raw: state.doc.raw,
        })
        .catch(e => {
          if (state.disposed) return
          state.note = {
            text: `draft not saved (${e instanceof Error ? e.message : String(e)}) — save the agent to keep these edits`,
            tone: AMBER,
          }
          emit()
        })
    }, STUDIO_AUTOSAVE_DEBOUNCE_MS)
  }

  const discardDraftFile = (): string | null => {
    const { drafts, error } = unpackDraftList(deps.listDrafts())
    if (error !== undefined) {
      const text = `saved drafts could not be read (${error})`
      state.note = { text, tone: AMBER }
      return text
    }
    let failedText: string | null = null
    for (const d of drafts) {
      const matches = base
        ? d.draft.baseIdentity?.filePath === base.identity.filePath
        : d.draft.baseIdentity === undefined
      if (matches) {
        const err = discardDraftError(deps.discardDraft(d.path))
        if (err !== null) {
          failedText = `the draft at ${d.path} could not be removed (${err}) — it will be offered again`
          state.note = { text: failedText, tone: AMBER }
        }
      }
    }
    return failedText
  }

  const adoptDoc = (next: AgentDocument): void => {
    state.doc = next
    armAutosave()
  }

  const commit = (edit: Parameters<typeof patchAgentDocument>[1]): boolean => {
    try {
      adoptDoc(patchAgentDocument(state.doc, edit))
      emit()
      return true
    } catch (e) {
      state.note = {
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
    if (state.view.kind !== 'guided') return
    state.view = { kind: 'guided', step: to, history: [...state.view.history, from] }
    const seed = guidedSeedFor(state.doc, to)
    state.textBuffer = seed
    state.textCursor = seed.length
    emit()
  }

  return { emit, snapshot, discardDraftFile, adoptDoc, commit, goStep }
}

function studioFieldMethods(
  state: StudioEditorState,
  { base }: StudioEditorPorts,
  { emit, adoptDoc, commit }: StudioEditorCore,
): Pick<
  StudioEditorMachine,
  | 'loadRaw'
  | 'commitTextField'
  | 'openFieldEditor'
  | 'closeFieldEditor'
  | 'setView'
  | 'setTextBuffer'
  | 'setTextCursor'
  | 'setScope'
> {
  return {
    loadRaw(content) {
      if (content === state.doc.raw) return
      const next = decodeAgentDocument(content, base?.identity.filePath)
      adoptDoc(next)
      const errs = next.diagnostics.filter(d => d.severity === 'error')
      state.note =
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
              state.note = { text: 'max turns must be a positive integer (empty clears)', tone: AMBER }
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
      if (ok && state.view.kind === 'advanced') {
        state.view = { ...state.view, editing: null }
        emit()
      }
    },

    openFieldEditor(field) {
      if (state.view.kind !== 'advanced') return
      if (
        field === 'name' ||
        field === 'description' ||
        field === 'skills' ||
        field === 'maxTurns' ||
        field === 'initialPrompt'
      ) {
        const seed = advancedFieldSeed(state.doc, field)
        state.textBuffer = seed
        state.textCursor = seed.length
      }
      state.view = { ...state.view, editing: field }
      emit()
    },

    closeFieldEditor() {
      if (state.view.kind !== 'advanced') return
      state.view = { ...state.view, editing: null }
      emit()
    },

    setView(next) {
      state.view = next
      emit()
    },
    setTextBuffer(value) {
      state.textBuffer = value
      emit()
    },
    setTextCursor(offset) {
      state.textCursor = offset
      emit()
    },
    setScope(next) {
      state.scope = next
      emit()
    },
  }
}

function studioGuidedMethods(
  state: StudioEditorState,
  ports: StudioEditorPorts,
  core: StudioEditorCore,
): Pick<
  StudioEditorMachine,
  | 'guidedDestination'
  | 'guidedMethod'
  | 'guidedDescribe'
  | 'guidedIdentity'
  | 'guidedPrompt'
  | 'guidedDescription'
  | 'guidedTools'
  | 'guidedModel'
  | 'guidedBack'
  | 'reviewEscape'
> {
  const { options, mode } = ports
  const { emit, commit, goStep } = core
  return {
    guidedDestination(next) {
      state.scope = next
      goStep('destination', 'method')
    },
    guidedMethod(method) {
      if (method === 'generate') goStep('method', 'describe')
      else goStep('method', 'identity')
    },
    guidedDescribe(prompt) {
      void runStudioGeneration(state, ports, core, prompt)
    },
    guidedIdentity(name) {
      const err = validateAgentIdentifier(name)
      if (err) {
        state.note = { text: err, tone: AMBER }
        emit()
        return
      }
      if (commit({ set: { name } })) goStep('identity', guidedNext('identity'))
    },
    guidedPrompt(body) {
      if (body.trim().length < 20) {
        state.note = { text: 'system prompt is too short (minimum 20 characters)', tone: AMBER }
        emit()
        return
      }
      if (commit({ body: body.trim() + '\n' })) goStep('prompt', guidedNext('prompt'))
    },
    guidedDescription(description) {
      if (!description.trim()) {
        state.note = { text: 'description is required — it tells Mercury when to delegate', tone: AMBER }
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
        state.view = { kind: 'review' }
        emit()
      }
    },
    guidedBack() {
      if (state.view.kind !== 'guided') return
      const history = [...state.view.history]
      const prev = history.pop()
      if (!prev) {
        options.onCancel()
        return
      }
      state.view = { kind: 'guided', step: prev, history }
      const seed = guidedSeedFor(state.doc, prev)
      state.textBuffer = seed
      state.textCursor = seed.length
      emit()
    },

    reviewEscape() {
      if (mode === 'create') {
        state.view = {
          kind: 'guided',
          step: 'model',
          history: ['destination', 'method', 'identity', 'prompt', 'description', 'tools'],
        }
        const seed = guidedSeedFor(state.doc, 'model')
        state.textBuffer = seed
        state.textCursor = seed.length
      } else {
        state.view = { kind: 'advanced', cursor: 0, editing: null }
      }
      emit()
    },
  }
}

function copySpecField<K extends keyof AgentSpecFields>(
  target: Partial<AgentSpecFields>,
  source: AgentSpecFields,
  key: K,
): void {
  target[key] = source[key]
}

function studioSaveMethods(
  state: StudioEditorState,
  { options, deps, mode, base, cwd }: StudioEditorPorts,
  { emit, discardDraftFile, adoptDoc }: StudioEditorCore,
): Pick<StudioEditorMachine, 'save' | 'mergeOntoTheirs' | 'clearConflict' | 'acceptRecover' | 'declineRecover'> {
  return {
    async save() {
      if (state.busy) return
      const validation = computeStudioValidation({
        doc: state.doc,
        existingAgents: options.getExistingAgents(),
        base,
        mode,
      })
      if (!validation.canSave) {
        state.note = { text: 'fix the errors above before saving', tone: AMBER }
        emit()
        return
      }
      state.busy = true
      emit()
      try {
        const receipt = await deps.saveDocument(
          base
            ? {
                kind: 'existing',
                identity: {
                  filePath: base.identity.filePath,
                  revision: state.baseRevision ?? base.identity.revision,
                },
              }
            : { kind: 'new', scope: state.scope, cwd, slug: state.doc.fields.name },
          state.doc,
        )
        const draftWarn = discardDraftFile()
        const savedLine = `${mode === 'create' ? 'Created' : 'Updated'} agent ${state.doc.fields.name} → ${receipt.path} (rev ${receipt.afterRevision}${receipt.semanticChanges.length > 0 ? `; changed: ${receipt.semanticChanges.join(', ')}` : ''})`
        options.onSaved(draftWarn !== null ? `${savedLine} · ${draftWarn}` : savedLine)
      } catch (e) {
        if (e instanceof AgentStoreError && e.code === 'revision-conflict') {
          state.conflict = { currentRaw: e.detail?.currentRaw ?? '' }
          state.note = {
            text: 'the file changed outside this draft — L loads theirs + re-applies your field edits · esc keeps editing',
            tone: AMBER,
          }
        } else {
          state.note = {
            text: e instanceof Error ? e.message : String(e),
            tone: CRIMSON,
          }
        }
      } finally {
        state.busy = false
        emit()
      }
    },

    mergeOntoTheirs() {
      if (!state.conflict) return
      try {
        const theirs = decodeAgentDocument(state.conflict.currentRaw, base?.identity.filePath)
        const edits: Partial<AgentSpecFields> = {}
        for (const key of new Set([...Object.keys(state.baseDocument.fields), ...Object.keys(state.doc.fields)]) as Set<keyof AgentSpecFields>) {
          if (key === 'mcpServers' || key === 'hooks') continue
          if (JSON.stringify(state.doc.fields[key]) !== JSON.stringify(state.baseDocument.fields[key])) {
            copySpecField(edits, state.doc.fields, key)
          }
        }
        const merged = patchAgentDocument(theirs, {
          set: edits,
          ...(state.doc.body !== state.baseDocument.body ? { body: state.doc.body } : {}),
        })
        adoptDoc(merged)
        state.baseDocument = theirs
        state.baseRevision = revisionDigest(state.conflict.currentRaw)
        state.conflict = null
        state.note = { text: 'their version loaded — your field edits re-applied on top; review and save again', tone: TEAL }
        emit()
      } catch (e) {
        state.note = { text: `merge failed: ${String(e)}`, tone: CRIMSON }
        emit()
      }
    },

    clearConflict() {
      state.conflict = null
      emit()
    },

    acceptRecover() {
      if (!state.recoverOffer) return
      try {
        const recovered = decodeAgentDocument(state.recoverOffer.raw, base?.identity.filePath)
        adoptDoc(recovered)
        state.note = { text: 'draft recovered — continuing where you left off', tone: TEAL }
        if (mode === 'create') state.view = { kind: 'advanced', cursor: 0, editing: null }
      } catch {
        state.note = { text: 'draft unreadable — starting fresh', tone: AMBER }
      }
      state.recoverOffer = null
      emit()
    },

    declineRecover() {
      if (!state.recoverOffer) return
      const err = discardDraftError(deps.discardDraft(state.recoverOffer.path))
      if (err !== null) {
        state.note = {
          text: `the draft at ${state.recoverOffer.path} could not be removed (${err}) — it will be offered again`,
          tone: AMBER,
        }
      }
      state.recoverOffer = null
      emit()
    },
  }
}

function studioLifetimeMethods(
  state: StudioEditorState,
  { deps }: StudioEditorPorts,
  { emit }: StudioEditorCore,
): Pick<StudioEditorMachine, 'abortGeneration' | 'dispose'> {
  return {
    abortGeneration() {
      if (!state.generationAbort) return false
      state.generationAbort.abort()
      state.note = { text: 'generation cancelled', tone: AMBER }
      emit()
      return true
    },

    dispose() {
      state.disposed = true
      if (state.autosaveTimer !== null) deps.clearTimer(state.autosaveTimer)
      state.autosaveTimer = null
      state.generationAbort?.abort()
      state.generationAbort = null
    },
  }
}

async function runStudioGeneration(
  state: StudioEditorState,
  { options, deps }: StudioEditorPorts,
  { emit, adoptDoc }: StudioEditorCore,
  prompt: string,
): Promise<void> {
  if (state.busy || state.disposed) return
  state.busy = true
  state.note = { text: 'generating agent from description …', tone: SECOND }
  emit()
  const controller = new AbortController()
  state.generationAbort = controller
  try {
    const generated = await deps.generate(
      prompt,
      options.getParentModel(),
      options.getExistingAgents().map(a => a.agentType),
      controller.signal,
    )
    if (state.disposed || controller.signal.aborted) return
    adoptDoc(
      patchAgentDocument(state.doc, {
        set: { name: generated.identifier, description: generated.whenToUse },
        body: generated.systemPrompt.trim() + '\n',
      }),
    )
    state.note = { text: `generated "${generated.identifier}" — review it below`, tone: TEAL }
    state.view = { kind: 'review' }
  } catch (e) {
    state.note = {
      text: `generation failed: ${e instanceof Error ? e.message : String(e)} — edit the description and ↵ retries`,
      tone: CRIMSON,
    }
  } finally {
    state.busy = false
    state.generationAbort = null
    emit()
  }
}
