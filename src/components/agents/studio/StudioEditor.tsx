import * as React from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import {
  decodeAgentDocument,
  patchAgentDocument,
} from '../../../services/agents/codec.js'
import type { AgentDocument } from '../../../services/agents/contracts.js'
import { newAgentPath } from '../../../services/agents/store.js'
import type { Tools } from '../../../Tool.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import { type EffortValue, resolveEffortTruth } from '../../../utils/effort.js'
import type { ModelName } from '../../../utils/model/model.js'
import { PERMISSION_MODES } from '../../../utils/permissions/PermissionMode.js'
import { editPromptInEditor } from '../../../utils/promptEditor.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import { Select } from '../../CustomSelect/select.js'
import { SectionHeader, StateBadge } from '../../mercury-ui/components.js'
import { truncateToWidth } from '../../mercury-ui/glyphs.js'
import { useSessionAccent } from '../../mercury-ui/sessionAccent.js'
import TextInput from '../../TextInput.js'
import { ColorPicker } from '../ColorPicker.js'
import { ToolSelector } from '../ToolSelector.js'
import { ModelSelector } from '../ModelSelector.js'
import { agentModelAvailabilityNote } from '../../../utils/model/agentModelPicker.js'
import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'
import {
  buildReviewFacts,
  computeStudioValidation,
  createStudioEditorMachine,
  effectiveStudioRuntime,
  FIELD_ROWS,
  fieldValueLabel,
  type EditorView,
  type FieldId,
  type GuidedStep,
  type StudioDraftBase,
  type StudioEditorMachine,
  type StudioEditorSnapshot,
  studioDestinationPath,
} from './studioEditorModel.js'

export type { StudioDraftBase } from './studioEditorModel.js'

// ============================================================================
// StudioEditor — the Ink SKIN over the ONE form machine (studioEditorModel;
// extracted whole — the anthropicLoginModel precedent).
//
//  THREE VIEWS OVER ONE DRAFT (brief): the draft IS an AgentDocument (the
//  lossless codec form); guided steps and advanced field editors commit
//  through the machine's patch door — one field at a time, byte-preserving
//  everything else — and the raw view round-trips the exact bytes through an
//  external editor. Switching views can never lose data because there is
//  only one artifact to lose.
//
//  This module renders and maps keys — nothing else. Every transition, gate
//  and spelling lives in the machine (identity pinned both directions by
//  prove-agent-face §1: the spellings live there, this skin retains none).
//  The editor-spawn seams (editPromptInEditor) stay here: spawning $EDITOR
//  is a host concern, and the machine takes the returned bytes.
// ============================================================================

type Props = {
  mode: 'create' | 'edit'
  /** Editing: the exact discovered base. */
  base?: StudioDraftBase
  /** Creating: preset destination scope (guided asks when absent). */
  cwd: string
  tools: Tools
  existingAgents: AgentDefinition[]
  parentModel: ModelName
  sessionEffort: EffortValue | undefined
  onSaved: (message: string) => void
  onCancel: () => void
}

export function StudioEditor({
  mode,
  base,
  cwd,
  tools,
  existingAgents,
  parentModel,
  sessionEffort,
  onSaved,
  onCancel,
}: Props): React.ReactNode {
  const accent = useSessionAccent().accent

  // ── the machine binding (live prop reads ride refs) ───────────────────────
  const existingRef = React.useRef(existingAgents)
  existingRef.current = existingAgents
  const parentModelRef = React.useRef(parentModel)
  parentModelRef.current = parentModel
  const onSavedRef = React.useRef(onSaved)
  onSavedRef.current = onSaved
  const onCancelRef = React.useRef(onCancel)
  onCancelRef.current = onCancel

  const snapListener = React.useRef<(s: StudioEditorSnapshot) => void>(() => {})
  const [machine] = React.useState<StudioEditorMachine>(() =>
    createStudioEditorMachine(
      {
        mode,
        ...(base !== undefined ? { base } : {}),
        cwd,
        getExistingAgents: () => existingRef.current,
        getParentModel: () => parentModelRef.current,
        onSaved: message => onSavedRef.current(message),
        onCancel: () => onCancelRef.current(),
      },
      s => snapListener.current(s),
    ),
  )
  const [snap, setSnap] = React.useState<StudioEditorSnapshot>(() => machine.snapshot())
  snapListener.current = setSnap
  React.useEffect(() => () => machine.dispose(), [machine])

  const { doc, view, note, busy, conflict, recoverOffer, textBuffer, textCursor } = snap

  const validation = React.useMemo(
    () => computeStudioValidation({ doc, existingAgents, base, mode }),
    [doc, existingAgents, base, mode],
  )

  const destinationPath = studioDestinationPath({ base, scope: snap.scope, cwd, name: doc.fields.name })

  const effective = React.useMemo(
    () => effectiveStudioRuntime({ doc, base, scope: snap.scope, parentModel, sessionEffort, tools }),
    [doc, base, snap.scope, parentModel, sessionEffort, tools],
  )

  // ── shared key handling for non-Select surfaces ───────────────────────────
  useInput(
    (input, key) => {
      if (busy) {
        if (key.escape) machine.abortGeneration()
        return
      }
      if (recoverOffer) {
        if (input === 'y' || key.return) machine.acceptRecover()
        else if (input === 'n' || key.escape) machine.declineRecover()
        return
      }
      if (conflict) {
        if (input === 'l' || input === 'L') machine.mergeOntoTheirs()
        else if (key.escape) machine.clearConflict()
        return
      }
      if (view.kind === 'review') {
        if (input === 's' || key.return) void machine.save()
        else if (input === 'v') machine.setView({ kind: 'advanced', cursor: 0, editing: null })
        else if (input === 'r') machine.setView({ kind: 'raw' })
        else if (key.escape) machine.reviewEscape()
        return
      }
      if (view.kind === 'raw') {
        if (input === 'e') {
          void editPromptInEditor(doc.raw).then(result => {
            if (result.content !== null) machine.loadRaw(result.content)
          })
        } else if (input === 'v') machine.setView({ kind: 'advanced', cursor: 0, editing: null })
        else if (key.return) machine.setView({ kind: 'review' })
        else if (key.escape) machine.setView({ kind: 'advanced', cursor: 0, editing: null })
        return
      }
      if (view.kind === 'advanced' && view.editing === null) {
        const rows = FIELD_ROWS.length + 2 // + raw view + review
        if (key.upArrow) machine.setView({ ...view, cursor: Math.max(0, view.cursor - 1) })
        else if (key.downArrow) machine.setView({ ...view, cursor: Math.min(rows - 1, view.cursor + 1) })
        else if (key.return) {
          if (view.cursor === FIELD_ROWS.length) machine.setView({ kind: 'raw' })
          else if (view.cursor === FIELD_ROWS.length + 1) machine.setView({ kind: 'review' })
          else {
            const field = FIELD_ROWS[view.cursor]!.id
            if (field === 'body') {
              void editPromptInEditor(doc.body).then(result => {
                if (result.content !== null && result.content !== doc.body) {
                  machine.commit({ body: result.content })
                }
              })
            } else if (field === 'background') {
              machine.commit({ set: { background: doc.fields.background ? undefined : true } })
            } else if (field === 'isolation') {
              machine.commit({ set: { isolation: doc.fields.isolation ? undefined : 'worktree' } })
            } else {
              machine.openFieldEditor(field)
            }
          }
        } else if (key.escape) {
          if (mode === 'create') machine.setView({ kind: 'review' })
          else onCancel()
        }
        return
      }
      if (view.kind === 'advanced' && view.editing !== null) {
        // Select-based editors own their input; esc falls through to here for
        // the text editors (TextInput submits via ↵).
        if (key.escape) machine.closeFieldEditor()
        return
      }
      if (view.kind === 'guided') {
        if (key.escape) machine.guidedBack()
        return
      }
    },
    { isActive: true },
  )

  // ── renders ───────────────────────────────────────────────────────────────
  const header = (
    <Box flexDirection="column">
      <Box>
        <StateBadge state="live" label={mode === 'create' ? 'create agent' : `edit ${doc.fields.name || base?.agent.agentType || ''}`} />
        <Text color={FAINT}>{`  →  ${truncateToWidth(destinationPath, 58)}`}</Text>
      </Box>
      {note ? <Text color={note.tone}>{truncateToWidth(note.text, 78)}</Text> : null}
    </Box>
  )

  if (recoverOffer) {
    return (
      <Box flexDirection="column">
        {header}
        <Box marginTop={1} flexDirection="column">
          <Text color={AMBER}>an unsaved draft from a previous session exists for this target.</Text>
          <Text color={FAINT}>y / ↵ recover it · n discard it</Text>
        </Box>
      </Box>
    )
  }

  if (busy) {
    return (
      <Box flexDirection="column">
        {header}
        <Box marginTop={1}>
          <Text color={SECOND}>◓ working … (esc cancels generation)</Text>
        </Box>
      </Box>
    )
  }

  if (conflict) {
    const theirs = decodeAgentDocument(conflict.currentRaw)
    return (
      <Box flexDirection="column">
        {header}
        <SectionHeader>Revision conflict</SectionHeader>
        <Text color={AMBER}>the file changed on disk while you edited.</Text>
        <Text color={FAINT}>{`theirs now: ${truncateToWidth(theirs.fields.description || '(no description)', 60)}`}</Text>
        <Text color={FAINT}>L load theirs + re-apply your edits · esc keep editing (save will keep refusing)</Text>
      </Box>
    )
  }

  if (view.kind === 'guided') {
    return (
      <Box flexDirection="column">
        {header}
        <GuidedStepView
          step={view.step}
          doc={doc}
          scope={snap.scope}
          cwd={cwd}
          textBuffer={textBuffer}
          textCursor={textCursor}
          setTextBuffer={v => machine.setTextBuffer(v)}
          setTextCursor={n => machine.setTextCursor(n)}
          tools={tools}
          onDestination={s => machine.guidedDestination(s)}
          onMethod={m => machine.guidedMethod(m)}
          onDescribe={prompt => machine.guidedDescribe(prompt)}
          onIdentity={name => machine.guidedIdentity(name)}
          onPrompt={body => machine.guidedPrompt(body)}
          onDescription={d => machine.guidedDescription(d)}
          onTools={selected => machine.guidedTools(selected)}
          onModel={m => machine.guidedModel(m)}
          onBack={() => machine.guidedBack()}
        />
      </Box>
    )
  }

  if (view.kind === 'raw') {
    const lines = doc.raw.split('\n')
    const MAX = 18
    return (
      <Box flexDirection="column">
        {header}
        <SectionHeader>Raw document (exact bytes)</SectionHeader>
        {lines.slice(0, MAX).map((l, i) => (
          <Text key={i} color={l.startsWith('---') ? FAINT : IVORY}>
            {truncateToWidth(l === '' ? ' ' : l, 78)}
          </Text>
        ))}
        {lines.length > MAX ? <Text color={FAINT}>{`  +${lines.length - MAX} more lines`}</Text> : null}
        {doc.diagnostics.filter(d => d.severity === 'error').map((d, i) => (
          <Text key={`d${i}`} color={CRIMSON}>{`  ✗ line ${d.line ?? '?'}: ${d.message}`}</Text>
        ))}
        <Box marginTop={1}>
          <Text color={FAINT}>e edit in $EDITOR (same codec + validation) · v advanced view · ↵ review · esc back</Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'review') {
    const { changed, diffLines } = buildReviewFacts(doc, base)
    // Availability is a session fact (never a validation error): a saved
    // model whose provider is signed out says so here instead of failing
    // silently at dispatch.
    const availability = agentModelAvailabilityNote(doc.fields.model)
    return (
      <Box flexDirection="column">
        {header}
        <SectionHeader>Review</SectionHeader>
        <Text>
          <Text color={FAINT}>{'destination  '}</Text>
          <Text color={IVORY}>{truncateToWidth(destinationPath, 62)}</Text>
        </Text>
        <Text>
          <Text color={FAINT}>{'fields       '}</Text>
          <Text color={changed.length > 0 ? IVORY : FAINT}>
            {changed.length > 0 ? changed.join(', ') : '(no field changes)'}
          </Text>
        </Text>
        <Text>
          <Text color={FAINT}>{'effective    '}</Text>
          <Text color={TEAL}>
            {`${effective.model}${effective.flooredFrom ? ` (floored from ${effective.flooredFrom})` : ''} · ${effective.effort.supportsEffort ? `effort ${effective.effort.label}` : effective.effort.label}${effective.effort.adjustedFrom ? ` (requested ${effective.effort.adjustedFrom})` : ''}`}
          </Text>
        </Text>
        {availability !== null ? (
          <Text>
            <Text color={FAINT}>{'availability '}</Text>
            <Text color={AMBER}>{truncateToWidth(`${availability} — /logins signs in`, 62)}</Text>
          </Text>
        ) : null}
        {effective.tools ? (
          <Text>
            <Text color={FAINT}>{'tools        '}</Text>
            <Text color={effective.tools.invalidTools.length > 0 ? AMBER : IVORY}>
              {effective.tools.hasWildcard
                ? 'all tools'
                : `${effective.tools.validTools.length} available${effective.tools.invalidTools.length > 0 ? ` · unknown: ${effective.tools.invalidTools.join(', ')}` : ''}`}
            </Text>
          </Text>
        ) : null}
        {diffLines.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {diffLines.map((l, i) => (
              <Text key={i} color={l.startsWith('+') ? TEAL : l.startsWith('-') ? CRIMSON : FAINT}>
                {truncateToWidth(`  ${l}`, 78)}
              </Text>
            ))}
          </Box>
        ) : null}
        {validation.errors.map((e, i) => (
          <Text key={`e${i}`} color={CRIMSON}>{`  ✗ ${truncateToWidth(e, 74)}`}</Text>
        ))}
        {validation.warnings.map((w, i) => (
          <Text key={`w${i}`} color={AMBER}>{`  ▲ ${truncateToWidth(w, 74)}`}</Text>
        ))}
        <Box marginTop={1}>
          <Text color={validation.canSave ? TEAL : FAINT}>
            {validation.canSave
              ? 's / ↵ save · v advanced · r raw · esc back'
              : 'save disabled while errors exist · v advanced · r raw · esc back'}
          </Text>
        </Box>
      </Box>
    )
  }

  // advanced
  const editing = view.editing
  return (
    <Box flexDirection="column">
      {header}
      <SectionHeader>All fields (one draft — guided, advanced and raw share it)</SectionHeader>
      {editing === null ? (
        <>
          {FIELD_ROWS.map((row, i) => {
            return (
              <Text key={row.id}>
                <Text color={i === view.cursor ? accent : FAINT}>{i === view.cursor ? '▸ ' : '  '}</Text>
                <Text color={FAINT}>{row.label.padEnd(20)}</Text>
                <Text color={IVORY}>{truncateToWidth(fieldValueLabel(doc, row.id), 50)}</Text>
              </Text>
            )
          })}
          {(doc.fields.mcpServers !== undefined || doc.fields.hooks !== undefined || doc.unknownKeys.length > 0) ? (
            <Text color={FAINT}>{`  (preserved as-is: ${[
              ...(doc.fields.mcpServers !== undefined ? ['mcpServers'] : []),
              ...(doc.fields.hooks !== undefined ? ['hooks'] : []),
              ...doc.unknownKeys,
            ].join(', ')} — edit in raw view)`}</Text>
          ) : null}
          <Text>
            <Text color={view.cursor === FIELD_ROWS.length ? accent : FAINT}>
              {view.cursor === FIELD_ROWS.length ? '▸ ' : '  '}
            </Text>
            <Text color={SECOND}>raw view (exact bytes)</Text>
          </Text>
          <Text>
            <Text color={view.cursor === FIELD_ROWS.length + 1 ? accent : FAINT}>
              {view.cursor === FIELD_ROWS.length + 1 ? '▸ ' : '  '}
            </Text>
            <Text color={TEAL}>review & save</Text>
          </Text>
          <Box marginTop={1}>
            <Text color={FAINT}>↑↓ field · ↵ edit · esc {mode === 'create' ? 'review' : 'cancel'}</Text>
          </Box>
        </>
      ) : (
        <FieldEditor
          field={editing}
          doc={doc}
          tools={tools}
          parentModel={parentModel}
          textBuffer={textBuffer}
          textCursor={textCursor}
          setTextBuffer={v => machine.setTextBuffer(v)}
          setTextCursor={n => machine.setTextCursor(n)}
          onText={(field, value) => machine.commitTextField(field, value)}
          onCommit={(edit): void => {
            if (machine.commit(edit)) machine.closeFieldEditor()
          }}
          onCancel={() => machine.closeFieldEditor()}
        />
      )}
    </Box>
  )
}

// ── guided step renderer ─────────────────────────────────────────────────────

function GuidedStepView(props: {
  step: GuidedStep
  doc: AgentDocument
  scope: 'user' | 'project'
  cwd: string
  tools: Tools
  textBuffer: string
  textCursor: number
  setTextBuffer: (v: string) => void
  setTextCursor: (v: number) => void
  onDestination: (scope: 'user' | 'project') => void
  onMethod: (m: 'generate' | 'manual') => void
  onDescribe: (prompt: string) => void
  onIdentity: (name: string) => void
  onPrompt: (body: string) => void
  onDescription: (d: string) => void
  onTools: (tools: string[] | undefined) => void
  onModel: (model?: string) => void
  onBack: () => void
}): React.ReactNode {
  const {
    step,
    doc,
    cwd,
    tools,
    textBuffer,
    textCursor,
    setTextBuffer,
    setTextCursor,
  } = props
  switch (step) {
    case 'destination':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>where should this agent live?</Text>
          <Select
            options={[
              {
                label: `Project (${newAgentPath('project', cwd, '<name>').replace('/<name>.md', '/')})`,
                value: 'project',
              },
              {
                label: `Personal (${newAgentPath('user', cwd, '<name>').replace('/<name>.md', '/')})`,
                value: 'user',
              },
            ]}
            onChange={(v: string) => props.onDestination(v as 'user' | 'project')}
            onCancel={props.onBack}
          />
        </Box>
      )
    case 'method':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>how do you want to start?</Text>
          <Select
            options={[
              { label: 'Generate with Mercury (describe it, review the result)', value: 'generate' },
              { label: 'Manual configuration', value: 'manual' },
            ]}
            onChange={(v: string) => props.onMethod(v as 'generate' | 'manual')}
            onCancel={props.onBack}
          />
        </Box>
      )
    case 'describe':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>describe what this agent should do and when it should be used:</Text>
          <TextInput
            value={textBuffer}
            onChange={setTextBuffer}
            onSubmit={() => props.onDescribe(textBuffer.trim())}
            placeholder="e.g. review recently written code for security issues…"
            columns={78}
            cursorOffset={textCursor}
            onChangeCursorOffset={setTextCursor}
            focus
            showCursor
          />
          <Text color={FAINT}>↵ generate · esc back</Text>
        </Box>
      )
    case 'identity':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>identifier (lowercase, hyphens — how it is invoked):</Text>
          <TextInput
            value={textBuffer}
            onChange={setTextBuffer}
            onSubmit={() => props.onIdentity(textBuffer.trim())}
            placeholder="e.g. code-reviewer"
            columns={60}
            cursorOffset={textCursor}
            onChangeCursorOffset={setTextCursor}
            focus
            showCursor
          />
          <Text color={FAINT}>↵ next · esc back</Text>
        </Box>
      )
    case 'prompt':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>system prompt (the agent's complete operating instructions):</Text>
          <TextInput
            value={textBuffer}
            onChange={setTextBuffer}
            onSubmit={() => props.onPrompt(textBuffer)}
            placeholder="You are …"
            columns={78}
            cursorOffset={textCursor}
            onChangeCursorOffset={setTextCursor}
            focus
            showCursor
          />
          <Text color={FAINT}>↵ next · esc back (tip: refine long prompts later in the advanced/raw views)</Text>
        </Box>
      )
    case 'description':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>description — tells Mercury WHEN to delegate to this agent:</Text>
          <TextInput
            value={textBuffer}
            onChange={setTextBuffer}
            onSubmit={() => props.onDescription(textBuffer)}
            placeholder="Use this agent when…"
            columns={78}
            cursorOffset={textCursor}
            onChangeCursorOffset={setTextCursor}
            focus
            showCursor
          />
          <Text color={FAINT}>↵ next · esc back</Text>
        </Box>
      )
    case 'tools':
      return (
        <Box flexDirection="column" marginTop={1}>
          <ToolSelector tools={tools} initialTools={doc.fields.tools} onComplete={props.onTools} onCancel={props.onBack} />
        </Box>
      )
    case 'model':
      return (
        <Box flexDirection="column" marginTop={1}>
          <ModelSelector initialModel={doc.fields.model} onComplete={props.onModel} onCancel={props.onBack} />
        </Box>
      )
    case 'review':
      return null
  }
}

// ── advanced field editors ───────────────────────────────────────────────────

function FieldEditor(props: {
  field: FieldId
  doc: AgentDocument
  tools: Tools
  parentModel: string
  textBuffer: string
  textCursor: number
  setTextBuffer: (v: string) => void
  setTextCursor: (v: number) => void
  onText: (field: FieldId, value: string) => void
  onCommit: (edit: Parameters<typeof patchAgentDocument>[1]) => void
  onCancel: () => void
}): React.ReactNode {
  const { field, doc, tools, textBuffer, textCursor, setTextBuffer, setTextCursor } = props
  const clear = { label: '(clear — use the default)', value: '__clear__' }
  const selectFor = (
    options: { label: string; value: string }[],
    apply: (v: string | undefined) => void,
  ): React.ReactNode => (
    <Select
      options={[...options, clear]}
      onChange={(v: string) => apply(v === '__clear__' ? undefined : v)}
      onCancel={props.onCancel}
    />
  )
  switch (field) {
    case 'name':
    case 'description':
    case 'skills':
    case 'maxTurns':
    case 'initialPrompt':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>{`${field}:`}</Text>
          <TextInput
            value={textBuffer}
            onChange={setTextBuffer}
            onSubmit={() => props.onText(field, textBuffer)}
            columns={78}
            cursorOffset={textCursor}
            onChangeCursorOffset={setTextCursor}
            focus
            showCursor
          />
          <Text color={FAINT}>↵ apply · esc cancel</Text>
        </Box>
      )
    case 'tools':
      return (
        <ToolSelector
          tools={tools}
          initialTools={doc.fields.tools}
          onComplete={selected => props.onCommit({ set: { tools: selected } })}
          onCancel={props.onCancel}
        />
      )
    case 'disallowedTools':
      return (
        <ToolSelector
          tools={tools}
          initialTools={doc.fields.disallowedTools ?? []}
          onComplete={selected =>
            props.onCommit({
              set: {
                disallowedTools:
                  selected === undefined || selected.length === 0 ? undefined : selected,
              },
            })
          }
          onCancel={props.onCancel}
        />
      )
    case 'model':
      return (
        <ModelSelector
          initialModel={doc.fields.model}
          onComplete={m =>
            props.onCommit({ set: { model: m === 'inherit' ? undefined : m } })
          }
          onCancel={props.onCancel}
        />
      )
    case 'effort': {
      // law: offer only the SELECTED model's resolved stops — inherit
      // previews against the PARENT model (the old
      // hardcoded family fallback privileged one spelling; inherit means
      // the parent, so the parent's stops are the honest offer).
      const previewModel = doc.fields.model && doc.fields.model !== 'inherit' ? doc.fields.model : props.parentModel
      // A model with no effort control offers NO stops and says so (the old
      // fallback offered the full ladder exactly when the model took none);
      // the clear row keeps 'inherit session'.
      const stops = resolveEffortTruth(previewModel, undefined).selectable
      const options = stops.map(l => ({ label: l, value: l }))
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>
            {stops.length > 0
              ? `effort (stops offered for ${previewModel}):`
              : `${previewModel} takes no effort setting — no stops to offer; the field stays 'inherit session'`}
          </Text>
          {selectFor(options, v =>
            props.onCommit({ set: { effort: v as EffortValue | undefined } }),
          )}
        </Box>
      )
    }
    case 'permissionMode':
      return selectFor(
        PERMISSION_MODES.map(m => ({ label: m, value: m })),
        v => props.onCommit({ set: { permissionMode: v as never } }),
      )
    case 'memory':
      return selectFor(
        ['user', 'project', 'local'].map(m => ({ label: m, value: m })),
        v => props.onCommit({ set: { memory: v as never } }),
      )
    case 'instructionProfile':
      return selectFor(
        ['auto', 'native'].map(m => ({ label: m, value: m })),
        v => props.onCommit({ set: { instructionProfile: v as never } }),
      )
    case 'color':
      return (
        <ColorPicker
          agentName={doc.fields.name || 'draft'}
          currentColor={(doc.fields.color as AgentColorName) ?? 'automatic'}
          onConfirm={c => props.onCommit({ set: { color: c as never } })}
        />
      )
    case 'body':
    case 'background':
    case 'isolation':
      return null
  }
}
