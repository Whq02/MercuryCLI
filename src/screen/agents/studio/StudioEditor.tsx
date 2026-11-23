import * as React from 'react'
import { useClaim } from '../../effects/effects.js'
import { Box, Text, useInput } from '../../themedRenderer.js'
import {
  decodeAgentDocument,
  patchAgentDocument,
} from '../../../crew/agents/codec.js'
import type { AgentDocument } from '../../../crew/agents/contracts.js'
import { newAgentPath } from '../../../crew/agents/store.js'
import type { Tools } from '../../../tools/kit/tool.js'
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js'
import { type EffortValue, resolveEffortTruth } from '../../../models/effort/effort.js'
import type { ModelName } from '../../../models/catalogue/engineModel.js'
import { offeredDefinitionModes } from '../../../tools/crewmate/agentPermissionPosture.js'
import { editPromptInEditor } from '../../composer/promptEditor.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../theme/mercuryPalette.js'
import { Select } from '../../select/Select.js'
import { SectionHeader, StateBadge } from '../../widgets/components.js'
import { truncateToWidth } from '../../theme/glyphs.js'
import { useSessionAccent } from '../../widgets/sessionAccent.js'
import TextInput from '../../composer/text-input/TextInput.js'
import { ColorPicker } from '../ColorPicker.js'
import { ToolSelector } from '../ToolSelector.js'
import { ModelSelector } from '../ModelSelector.js'
import type { AgentColorName } from '../../../tools/crewmate/crewmateColors.js'
import {
  computeStudioValidation,
  createStudioEditorMachine,
  effectiveStudioRuntime,
  FIELD_ROWS,
  fieldValueLabel,
  type FieldId,
  type GuidedStep,
  type StudioDraftBase,
  type StudioEditorMachine,
  type StudioEditorSnapshot,
  studioDestinationPath,
} from './studioEditorModel.js'
import { studioReviewView } from './studioEditorView.js'

export type { StudioDraftBase } from './studioEditorModel.js'


type Props = {
  mode: 'create' | 'edit'
  base?: StudioDraftBase
  cwd: string
  tools: Tools
  existingAgents: AgentDefinition[]
  parentModel: ModelName
  sessionEffort: EffortValue | undefined
  sovereignConsent: boolean
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
  sovereignConsent,
  onSaved,
  onCancel,
}: Props): React.ReactNode {
  const accent = useSessionAccent().accent

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
  useClaim(() => () => machine.dispose(), [machine])

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
        const rows = FIELD_ROWS.length + 2
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
    return studioReviewView({ doc, base, header, destinationPath, effective, validation })
  }

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
          sovereignConsent={sovereignConsent}
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


function FieldEditor(props: {
  field: FieldId
  doc: AgentDocument
  tools: Tools
  parentModel: string
  sovereignConsent: boolean
  textBuffer: string
  textCursor: number
  setTextBuffer: (v: string) => void
  setTextCursor: (v: number) => void
  onText: (field: FieldId, value: string) => void
  onCommit: (edit: Parameters<typeof patchAgentDocument>[1]) => void
  onCancel: () => void
}): React.ReactNode {
  const { field, doc, tools, textBuffer, textCursor, setTextBuffer, setTextCursor } = props
  const clear = { label: '(clear — use the default)', value: '__clear__' as const }
  const selectFor = <T extends string>(
    options: { label: string; value: T }[],
    apply: (v: T | undefined) => void,
  ): React.ReactNode => (
    <Select<T | '__clear__'>
      options={[...options, clear]}
      onChange={v => apply(v === '__clear__' ? undefined : v)}
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
          explicitSelection
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
      const previewModel = doc.fields.model && doc.fields.model !== 'inherit' ? doc.fields.model : props.parentModel
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
            props.onCommit({ set: { effort: v } }),
          )}
        </Box>
      )
    }
    case 'permissionMode':
      return selectFor(
        offeredDefinitionModes(props.sovereignConsent).map(m => ({ label: m, value: m })),
        v => props.onCommit({ set: { permissionMode: v } }),
      )
    case 'memory':
      return selectFor(
        (['user', 'project', 'local'] as const).map(m => ({ label: m, value: m })),
        v => props.onCommit({ set: { memory: v } }),
      )
    case 'instructionProfile':
      return selectFor(
        (['auto', 'native'] as const).map(m => ({ label: m, value: m })),
        v => props.onCommit({ set: { instructionProfile: v } }),
      )
    case 'color':
      return (
        <ColorPicker
          agentName={doc.fields.name || 'draft'}
          currentColor={(doc.fields.color as AgentColorName) ?? 'automatic'}
          onConfirm={c => props.onCommit({ set: { color: c } })}
        />
      )
    case 'body':
    case 'background':
    case 'isolation':
      return null
  }
}
