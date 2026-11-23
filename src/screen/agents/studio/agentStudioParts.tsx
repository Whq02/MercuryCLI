import * as React from 'react'
import { Box, Text, type useInput } from '../../themedRenderer.js'
import type { CommandResultDisplay } from '../../../commands/catalogue/commands.js'
import type { useMergedTools } from '../../../tools/kit/useMergedTools.js'
import type { AgentEstateEntry } from '../../../crew/agents/resolver.js'
import {
  setAgentDisabled,
  setAgentOverride,
} from '../../../crew/agents/overrides.js'
import type { AppState } from '../../app-state/AppStateStore.js'
import type { Tools } from '../../../tools/kit/tool.js'
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js'
import { editFileInEditor } from '../../composer/promptEditor.js'
import { AMBER, CRIMSON, FAINT, IVORY, TEAL } from '../../theme/mercuryPalette.js'
import {
  CommandCenter,
  SectionHeader,
} from '../../widgets/components.js'
import { GLYPH, truncateToWidth } from '../../theme/glyphs.js'
import type { useSessionAccent } from '../../widgets/sessionAccent.js'
import type { useFlatList } from '../../widgets/useFlatList.js'
import type { useEngineModel } from '../../model-picker/useEngineModel.js'
import TextInput from '../../composer/text-input/TextInput.js'
import { StudioEditor, type StudioDraftBase } from './StudioEditor.js'
import { ModelSelector } from '../ModelSelector.js'
import {
  isFileBacked,
  SCOPE_TABS,
  STATUS_FILTERS,
  type StudioRow,
  type StudioScopeTab,
  type StudioStatusFilter,
} from './studioData.js'

export type Mode =
  | { kind: 'library' }
  | { kind: 'inspect'; row: StudioRow }
  | { kind: 'create' }
  | { kind: 'edit'; base: StudioDraftBase }
  | { kind: 'delete-confirm'; agent: AgentDefinition }
  | { kind: 'trash' }
  | { kind: 'clone'; agent: AgentDefinition; buffer: string }
  | { kind: 'testdrive'; agent: AgentDefinition; buffer: string }
  | { kind: 'override-model'; agent: AgentDefinition }


type Setter<T> = React.Dispatch<React.SetStateAction<T>>
type InputKey = Parameters<Parameters<typeof useInput>[0]>[1]
type FlatList = ReturnType<typeof useFlatList<StudioRow>>
type SessionEffort = AppState['effortValue']
type OnExit = (
  result?: string,
  options?: { display?: CommandResultDisplay; nextInput?: string },
) => void

type LibraryKeysArgs = {
  mode: Mode
  fl: FlatList
  setFilter: Setter<StudioStatusFilter>
  setTab: Setter<StudioScopeTab>
  query: string
  setQuery: Setter<string>
  cwd: string
  refresh: () => Promise<void>
  setMode: Setter<Mode>
}

export function libraryKeysOf({ mode, fl, setFilter, setTab, query, setQuery, cwd, refresh, setMode }: LibraryKeysArgs, input: string, key: InputKey): void {
  if (mode.kind !== 'library') return
  const row = fl.selected
  if (key.tab) {
    if (key.shift) {
      setFilter(f => STATUS_FILTERS[(STATUS_FILTERS.indexOf(f) + 1) % STATUS_FILTERS.length]!)
    } else {
      setTab(t => SCOPE_TABS[(SCOPE_TABS.indexOf(t) + 1) % SCOPE_TABS.length]!)
    }
    return
  }
  if (key.backspace || key.delete) {
    if (query.length > 0) setQuery(q => q.slice(0, -1))
    return
  }
  if (input === ' ') {
    if (!row?.agent) return
    if (row.agent.source === 'built-in') return
    const target = row.agent
    void setAgentDisabled('user', cwd, target.agentType, target.disabled !== true)
      .then(() => refresh())
      .then(() =>
        fl.setNote({
          text: `${target.disabled ? 'enabled' : 'disabled'} ${target.agentType}`,
          kind: 'ok',
        }),
      )
      .catch(e => fl.setNote({ text: String(e), kind: 'fail' }))
    return
  }
  if (input === 'N') {
    setMode({ kind: 'create' })
    return
  }
  if (input === 'R') {
    fl.setNote({ text: 'reloading definitions from disk …', kind: 'pending' })
    void refresh().then(() => fl.setNote({ text: `${GLYPH.check} reloaded`, kind: 'ok' }))
    return
  }
  if (input === 'U') {
    setMode({ kind: 'trash' })
    return
  }
  if (
    input &&
    input.length === 1 &&
    !key.ctrl &&
    !key.meta &&
    input >= ' ' &&
    input === input.toLowerCase()
  ) {
    setQuery(q => q + input)
  }
}

type InspectKeysArgs = {
  mode: Mode
  setMode: Setter<Mode>
  fl: FlatList
  done: (message: string) => void
  cwd: string
}

export function inspectKeysOf({ mode, setMode, fl, done, cwd }: InspectKeysArgs, input: string, key: InputKey): void {
  if (mode.kind !== 'inspect') return
  const row = mode.row
  const agent = row.agent
  if (key.escape || key.leftArrow) {
    setMode({ kind: 'library' })
    return
  }
  if (row.kind === 'invalid') {
    if (input === 'o' && row.invalid) {
      void editFileInEditor(row.invalid.path).then(r => {
        if (r.error) fl.setNote({ text: r.error, kind: 'fail' })
        else done(`Edited invalid file ${row.invalid!.path} in editor`)
      })
    }
    return
  }
  if (!agent) return
  if (input === 'e') {
    if (isFileBacked(agent)) {
      setMode({
        kind: 'edit',
        base: { identity: { filePath: agent.filePath, revision: agent.revision }, agent },
      })
    }
    return
  }
  if (input === 'd' && !key.ctrl && !key.meta) {
    if (isFileBacked(agent)) setMode({ kind: 'delete-confirm', agent })
    return
  }
  if (input === 'c' && !key.ctrl && !key.meta) {
    if (isFileBacked(agent) || agent.source === 'extension') {
      setMode({ kind: 'clone', agent, buffer: `${agent.agentType}-copy` })
    }
    return
  }
  if (input === 't') {
    setMode({ kind: 'testdrive', agent, buffer: '' })
    return
  }
  if (input === 'o') {
    if (isFileBacked(agent)) {
      void editFileInEditor(agent.filePath).then(r => {
        if (r.error) fl.setNote({ text: r.error, kind: 'fail' })
        else done(`Opened ${agent.agentType} in editor — changes hot-reload`)
      })
    }
    return
  }
  if (input === 'x') {
    if (agent.source === 'built-in') return
    void setAgentDisabled('user', cwd, agent.agentType, agent.disabled !== true)
      .then(() => done(`${agent.disabled ? 'Enabled' : 'Disabled'} ${agent.agentType}`))
      .catch(e => fl.setNote({ text: String(e), kind: 'fail' }))
    return
  }
  if (input === 'm') {
    setMode({ kind: 'override-model', agent })
    return
  }
}

type ModelOverrideArgs = {
  mode: Extract<Mode, { kind: 'override-model' }>
  setMode: Setter<Mode>
  cwd: string
  done: (message: string) => void
  fl: FlatList
}

export function modelOverrideView({ mode, setMode, cwd, done, fl }: ModelOverrideArgs): React.ReactNode {
  const agent = mode.agent
  return (
    <CommandCenter
      view="agents"
      subtitle="agent studio · model override"
      onClose={() => setMode({ kind: 'inspect', row: { id: 'back', kind: 'agent', agent } })}
      captureInput={false}
      footer=""
    >
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>{`Model override for ${agent.agentType}`}</SectionHeader>
        <ModelSelector
          initialModel={agent.operatorOverride?.model}
          onComplete={m => {
            const cleared = m === undefined || m === 'inherit'
            void setAgentOverride('user', cwd, agent.agentType, cleared ? undefined : { model: m })
              .then(() => done(cleared ? `Cleared model override for ${agent.agentType}` : `Model override for ${agent.agentType}: ${m}`))
              .catch(e => fl.setNote({ text: String(e), kind: 'fail' }))
          }}
          onCancel={() => setMode({ kind: 'inspect', row: { id: 'back', kind: 'agent', agent } })}
        />
      </Box>
    </CommandCenter>
  )
}

type StudioEditorPaneArgs = {
  mode: Extract<Mode, { kind: 'create' | 'edit' }>
  setMode: Setter<Mode>
  cwd: string
  mergedTools: ReturnType<typeof useMergedTools>
  agentDefinitions: AppState['agentDefinitions']
  parentModel: ReturnType<typeof useEngineModel>
  sessionEffort: SessionEffort
  toolPermissionContext: AppState['toolPermissionContext']
  done: (message: string) => void
  initialMode: 'library' | 'create' | undefined
  changes: string[]
  onExit: OnExit
}

export function studioEditorPane({ mode, setMode, cwd, mergedTools, agentDefinitions, parentModel, sessionEffort, toolPermissionContext, done, initialMode, changes, onExit }: StudioEditorPaneArgs): React.ReactNode {
  return (
    <CommandCenter
      view="agents"
      subtitle={mode.kind === 'create' ? 'agent studio · create' : 'agent studio · edit'}
      onClose={() => setMode({ kind: 'library' })}
      captureInput={false}
      footer=""
    >
      <StudioEditor
        mode={mode.kind}
        {...(mode.kind === 'edit' ? { base: mode.base } : {})}
        cwd={cwd}
        tools={mergedTools}
        existingAgents={agentDefinitions.allAgents}
        parentModel={parentModel}
        sessionEffort={sessionEffort}
        sovereignConsent={toolPermissionContext.isBypassPermissionsModeAvailable === true}
        onSaved={done}
        onCancel={() => {
          if (initialMode === 'create' && changes.length === 0 && mode.kind === 'create') {
            onExit('Agent creation cancelled', { display: 'system' })
          } else {
            setMode({ kind: 'library' })
          }
        }}
      />
    </CommandCenter>
  )
}

type StudioLibraryArgs = {
  onExit: OnExit
  changes: string[]
  footer: string
  mode: Mode
  setMode: Setter<Mode>
  trashSel: number
  runClone: (agent: AgentDefinition, newName: string) => void
  runTestDrive: (agent: AgentDefinition, prompt: string) => void
  parentModel: ReturnType<typeof useEngineModel>
  sessionEffort: SessionEffort
  mergedTools: ReturnType<typeof useMergedTools>
  estateRef: { current: Map<string, AgentEstateEntry> }
  fl: FlatList
  query: string
  tab: StudioScopeTab
  filter: StudioStatusFilter
  accent: ReturnType<typeof useSessionAccent>['accent']
  TrashView: (props: { sel: number }) => React.ReactNode
  TestDrivePane: (props: {
    agent: AgentDefinition
    buffer: string
    onChange: (v: string) => void
    onSubmit: () => void
    parentModel: string
    sessionEffort: SessionEffort
    tools: Tools
  }) => React.ReactNode
  InspectorPane: (props: {
    row: StudioRow
    estate: Map<string, AgentEstateEntry>
    parentModel: string
    sessionEffort: SessionEffort
    tools: Tools
  }) => React.ReactNode
  LibraryPane: (props: {
    fl: FlatList
    query: string
    tab: StudioScopeTab
    filter: StudioStatusFilter
    accent: string
  }) => React.ReactNode
}

export function studioLibraryView({ onExit, changes, footer, mode, setMode, trashSel, runClone, runTestDrive, parentModel, sessionEffort, mergedTools, estateRef, fl, query, tab, filter, accent, TrashView, TestDrivePane, InspectorPane, LibraryPane }: StudioLibraryArgs): React.ReactNode {
  return (
    <CommandCenter
      view="agents"
      subtitle="agent studio"
      onClose={() => {
        onExit(
          changes.length > 0 ? `Agent changes:\n${changes.join('\n')}` : 'Agent Studio closed',
          { display: changes.length > 0 ? undefined : 'system' },
        )
      }}
      captureInput={false}
      footer={footer}
      bodyOwnsPageKeys={mode.kind === 'library' || mode.kind === 'trash'}
    >
      <Box flexDirection="column">
        {mode.kind === 'delete-confirm' ? (
          <Box marginTop={1} flexDirection="column">
            <SectionHeader>Delete agent</SectionHeader>
            <Text>
              <Text color={IVORY}>{`delete ${mode.agent.agentType}? `}</Text>
              <Text color={FAINT}>
                {`moves the file to the recovery area (press U to restore)`}
              </Text>
            </Text>
            <Text color={FAINT}>{truncateToWidth(`  ${(mode.agent as { filePath?: string }).filePath ?? ''}`, 76)}</Text>
          </Box>
        ) : mode.kind === 'trash' ? (
          <TrashView sel={trashSel} />
        ) : mode.kind === 'clone' ? (
          <Box marginTop={1} flexDirection="column">
            <SectionHeader>{`Clone ${mode.agent.agentType}`}</SectionHeader>
            <Text color={FAINT}>new identifier (a lossless copy lands in the project scope):</Text>
            <TextInput
              value={mode.buffer}
              onChange={v => setMode({ ...mode, buffer: v })}
              onSubmit={() => runClone(mode.agent, mode.buffer.trim())}
              columns={50}
              cursorOffset={mode.buffer.length}
              onChangeCursorOffset={() => {}}
              focus
              showCursor
            />
          </Box>
        ) : mode.kind === 'testdrive' ? (
          <TestDrivePane
            agent={mode.agent}
            buffer={mode.buffer}
            onChange={v => setMode({ ...mode, buffer: v })}
            onSubmit={() => {
              if (mode.buffer.trim()) runTestDrive(mode.agent, mode.buffer.trim())
            }}
            parentModel={parentModel}
            sessionEffort={sessionEffort}
            tools={mergedTools}
          />
        ) : mode.kind === 'inspect' ? (
          <InspectorPane
            row={mode.row}
            estate={estateRef.current}
            parentModel={parentModel}
            sessionEffort={sessionEffort}
            tools={mergedTools}
          />
        ) : (
          <LibraryPane
            fl={fl}
            query={query}
            tab={tab}
            filter={filter}
            accent={accent}
          />
        )}
        {fl.note ? (
          <Box marginTop={1}>
            <Text
              color={
                fl.note.kind === 'ok'
                  ? TEAL
                  : fl.note.kind === 'fail'
                    ? CRIMSON
                    : fl.note.kind === 'warn'
                      ? AMBER
                      : FAINT
              }
            >
              {truncateToWidth(fl.note.text, 76)}
            </Text>
          </Box>
        ) : null}
      </Box>
    </CommandCenter>
  )
}
