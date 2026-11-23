import * as React from 'react'
import { Box, Text, useInput } from '../../themedRenderer.js'
import type { CommandResultDisplay } from '../../../commands/catalogue/commands.js'
import { useMergedTools } from '../../../tools/kit/useMergedTools.js'
import { reloadAgentDefinitionsIntoAppState } from '../useAgentsChange.js'
import {
  type AgentEstateEntry,
  resolveEffectiveAgentRuntime,
} from '../../../crew/agents/resolver.js'
import {
  AgentStoreError,
  deleteAgentToTrash,
  listAgentTrash,
  restoreAgentFromTrash,
} from '../../../crew/agents/store.js'
import {
  decodeAgentDocument,
  patchAgentDocument,
  serializeAgentMarkdown,
} from '../../../crew/agents/codec.js'
import { saveAgentDocument } from '../../../crew/agents/store.js'
import { useAppState, useSetAppState } from '../../app-state/AppState.js'
import type { AppState } from '../../app-state/AppStateStore.js'
import type { Tools } from '../../../tools/kit/tool.js'
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js'
import { SCOUT_TOOLS_DESCRIPTION } from '../../../tools/crewmate/scoutPolicy.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../theme/mercuryPalette.js'
import {
  EmptyState,
  SectionHeader,
  StateBadge,
} from '../../widgets/components.js'
import { truncateToWidth } from '../../theme/glyphs.js'
import { useSessionAccent } from '../../widgets/sessionAccent.js'
import { useFlatList } from '../../widgets/useFlatList.js'
import { popupListWindow, PopupListViewport, usePopupListNavigation } from '../../select/popup-list.js'
import { useEngineModel } from '../../model-picker/useEngineModel.js'
import { usePublish } from '../../effects/effects.js'
import TextInput from '../../composer/text-input/TextInput.js'
import { getAgentSourceDisplayName } from '../utils.js'
import { agentModelAvailabilityNote } from '../../../models/catalogue/agentModelPicker.js'
import {
  buildStudioRows,
  isFileBacked,
  type StudioRow,
  type StudioScopeTab,
  type StudioStatusFilter,
} from './studioData.js'
import { readFileSync } from 'node:fs'
import { inspectKeysOf, libraryKeysOf, modelOverrideView, studioEditorPane, studioLibraryView, type Mode } from './agentStudioParts.js'


type Props = {
  tools: Tools
  initialMode?: 'library' | 'create'
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay; nextInput?: string },
  ) => void
}

const MAX_ROWS = 12

const SOURCE_SHORT: Record<AgentDefinition['source'], string> = {
  'built-in': 'built-in',
  extension: 'extension',
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  policySettings: 'managed',
  flagSettings: 'cli',
}

export function AgentStudio({ tools, initialMode, onExit }: Props): React.ReactNode {
  const accent = useSessionAccent().accent
  const agentDefinitions = useAppState((s: AppState) => s.agentDefinitions)
  const mcpTools = useAppState((s: AppState) => s.mcp.tools)
  const toolPermissionContext = useAppState((s: AppState) => s.toolPermissionContext)
  const sessionEffort = useAppState((s: AppState) => s.effortValue)
  const setAppState = useSetAppState()
  const mergedTools = useMergedTools(tools, mcpTools, toolPermissionContext)
  const parentModel = useEngineModel()
  const cwd = getCwd()

  const [mode, setMode] = React.useState<Mode>(
    initialMode === 'create' ? { kind: 'create' } : { kind: 'library' },
  )
  const [query, setQuery] = React.useState('')
  const [tab, setTab] = React.useState<StudioScopeTab>('all')
  const [filter, setFilter] = React.useState<StudioStatusFilter>('all')
  const [changes, setChanges] = React.useState<string[]>([])

  const estateRef = React.useRef<Map<string, AgentEstateEntry>>(new Map())

  const buildRows = React.useCallback(async (): Promise<StudioRow[]> => {
    const built = buildStudioRows(agentDefinitions, { tab, filter, query })
    estateRef.current = built.estate
    return built.rows
  }, [agentDefinitions, tab, filter, query])

  const refresh = React.useCallback(async (): Promise<void> => {
    await reloadAgentDefinitionsIntoAppState(cwd, setAppState, { invalidate: true })
  }, [cwd, setAppState])

  const fl = useFlatList<StudioRow>({
    load: buildRows,
    maxRows: MAX_ROWS,
    charKeys: false,
    isActive: mode.kind === 'library',
    onClose: () => {
      if (query) setQuery('')
      else {
        onExit(
          changes.length > 0 ? `Agent changes:\n${changes.join('\n')}` : 'Agent Studio closed',
          { display: changes.length > 0 ? undefined : 'system' },
        )
      }
    },
    onPrimary: row => setMode({ kind: 'inspect', row }),
    reloadNote: 're-read agent definitions',
    rowId: r => r.id,
  })

  const reloadRef = React.useRef(fl.reload)
  reloadRef.current = fl.reload
  usePublish(() => {
    reloadRef.current()
  }, [query, tab, filter, agentDefinitions])

  const done = React.useCallback(
    (message: string): void => {
      setChanges(prev => [...prev, message])
      void refresh()
      setMode({ kind: 'library' })
    },
    [refresh],
  )

  useInput(
    (input, key) => libraryKeysOf({ mode, fl, setFilter, setTab, query, setQuery, cwd, refresh, setMode }, input, key),
    { isActive: mode.kind === 'library' },
  )

  const inspected = mode.kind === 'inspect' ? mode.row : null
  useInput(
    (input, key) => inspectKeysOf({ mode, setMode, fl, done, cwd }, input, key),
    { isActive: mode.kind === 'inspect' },
  )

  useInput(
    (input, key) => {
      if (mode.kind !== 'delete-confirm') return
      const agent = mode.agent
      if (input === 'y' || key.return) {
        if (!isFileBacked(agent)) return
        void deleteAgentToTrash(
          { filePath: agent.filePath, revision: agent.revision },
          {
            agentType: agent.agentType,
            source: agent.source as Exclude<typeof agent.source, 'built-in' | 'extension'>,
          },
        )
          .then(entry => done(`Deleted ${agent.agentType} → recoverable in trash (U) as ${entry.id}`))
          .catch(e => {
            fl.setNote({
              text: e instanceof AgentStoreError ? e.message : String(e),
              kind: 'fail',
            })
            setMode({ kind: 'library' })
          })
      } else if (input === 'n' || key.escape) {
        setMode({
          kind: 'inspect',
          row: { id: 'back', kind: 'agent', agent },
        })
      }
    },
    { isActive: mode.kind === 'delete-confirm' },
  )

  useInput(
    (_input, key) => {
      if (mode.kind !== 'clone' && mode.kind !== 'testdrive') return
      if (key.escape) setMode({ kind: 'library' })
    },
    { isActive: mode.kind === 'clone' || mode.kind === 'testdrive' },
  )

  const runClone = React.useCallback(
    (agent: AgentDefinition, newName: string): void => {
      void (async () => {
        try {
          let raw: string
          if (isFileBacked(agent)) {
            raw = readFileSync(agent.filePath, 'utf-8')
          } else if (agent.source === 'extension') {
            raw = serializeAgentMarkdown(
              {
                name: agent.agentType,
                description: agent.whenToUse,
                ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
                ...(agent.model !== undefined ? { model: agent.model } : {}),
              },
              (agent as { getSystemPrompt: () => string }).getSystemPrompt(),
            )
          } else {
            return
          }
          const doc = decodeAgentDocument(raw)
          const renamed = patchAgentDocument(doc, { set: { name: newName } })
          const receipt = await saveAgentDocument(
            { kind: 'new', scope: 'project', cwd, slug: newName },
            renamed,
          )
          done(`Cloned ${agent.agentType} → ${newName} at ${receipt.path}`)
        } catch (e) {
          fl.setNote({
            text: e instanceof Error ? e.message : String(e),
            kind: 'fail',
          })
        }
      })()
    },
    [cwd, done, fl],
  )

  const runTestDrive = React.useCallback(
    (agent: AgentDefinition, prompt: string): void => {
      const eff = resolveEffectiveAgentRuntime(agent, {
        parentModel,
        sessionEffort,
        tools: mergedTools,
      })
      const revision = (agent as { revision?: string }).revision ?? 'in-memory'
      const nextInput =
        `Test-drive the agent "${agent.agentType}" (definition revision ${revision}; ` +
        `effective model ${eff.model}, effort ${eff.effort.label}): spawn it with the Crewmate tool ` +
        `(crewmate_type: "${agent.agentType}", isolation: "worktree" so it works in a disposable copy) ` +
        `on this prompt, then report its result and whether it matched the definition's intent:\n\n${prompt}`
      onExit(undefined, { display: 'skip', nextInput })
    },
    [parentModel, sessionEffort, mergedTools, onExit],
  )

  const [trashSel, setTrashSel] = React.useState(0)
  usePopupListNavigation(trashSel, mode.kind === 'trash' ? listAgentTrash().length : 0, 10, setTrashSel, mode.kind === 'trash')
  useInput(
    (input, key) => {
      if (mode.kind !== 'trash') return
      const entries = listAgentTrash()
      if (key.escape || key.leftArrow) {
        setMode({ kind: 'library' })
        return
      }
      if (key.return || input === 'u') {
        const entry = entries[Math.min(trashSel, entries.length - 1)]
        if (!entry) return
        void restoreAgentFromTrash(entry.id)
          .then(r => done(`Restored ${entry.agentType} → ${r.path}`))
          .catch(e =>
            fl.setNote({
              text: e instanceof AgentStoreError ? e.message : String(e),
              kind: 'fail',
            }),
          )
      }
    },
    { isActive: mode.kind === 'trash' },
  )


  if (mode.kind === 'override-model') return modelOverrideView({ mode, setMode, cwd, done, fl })

  if (mode.kind === 'create' || mode.kind === 'edit') return studioEditorPane({ mode, setMode, cwd, mergedTools, agentDefinitions, parentModel, sessionEffort, toolPermissionContext, done, initialMode, changes, onExit })

  const inspectFooter = (agent: NonNullable<StudioRow['agent']>): string => {
    const verbs: string[] = []
    if (isFileBacked(agent)) verbs.push('e edit', 'd delete')
    if (isFileBacked(agent) || agent.source === 'extension') verbs.push('c clone')
    verbs.push('t test drive')
    if (agent.source !== 'built-in') verbs.push('x toggle')
    verbs.push('m model override')
    if (isFileBacked(agent)) verbs.push('o editor')
    verbs.push('esc back')
    return verbs.join(' · ')
  }
  const librarySpace = fl.selected?.agent && fl.selected.agent.source !== 'built-in' ? 'Space toggle · ' : ''
  const footer =
    mode.kind === 'inspect'
      ? inspected?.kind === 'invalid'
        ? 'o open in editor · esc back'
        : inspected?.agent
          ? inspectFooter(inspected.agent)
          : 'esc back'
      : mode.kind === 'trash'
        ? '↑↓ move · pgup/pgdn page · ↵/u restore · esc back'
        : mode.kind === 'delete-confirm'
          ? 'y / ↵ delete (recoverable) · n / esc cancel'
          : mode.kind === 'clone'
            ? '↵ clone under the new identifier · esc back'
            : mode.kind === 'testdrive'
              ? '↵ stage in composer · esc cancel'
              : query
                ? '↑↓ move · pgup/pgdn page · ↵ inspect · esc clear search'
                : `type to search · ↑↓ · pgup/pgdn page · ↵ inspect · ${librarySpace}N new · U trash · R reload · tab scope · shift+tab filter · esc close`

  return studioLibraryView({ onExit, changes, footer, mode, setMode, trashSel, runClone, runTestDrive, parentModel, sessionEffort, mergedTools, estateRef, fl, query, tab, filter, accent, TrashView, TestDrivePane, InspectorPane, LibraryPane })
}


function LibraryPane({
  fl,
  query,
  tab,
  filter,
  accent,
}: {
  fl: ReturnType<typeof useFlatList<StudioRow>>
  query: string
  tab: StudioScopeTab
  filter: StudioStatusFilter
  accent: string
}): React.ReactNode {
  const { visible, above, below, clampedSel, list, loadError } = fl
  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text color={FAINT}>{'search: '}</Text>
        <Text color={query ? IVORY : FAINT}>{query || '(type to filter)'}</Text>
        <Text color={accent}>▁</Text>
        <Text color={FAINT}>{`   scope `}</Text>
        <Text color={SECOND}>{tab}</Text>
        <Text color={FAINT}>{` · filter `}</Text>
        <Text color={filter === 'all' ? FAINT : AMBER}>{filter}</Text>
      </Box>
      {fl.raw === null ? (
        <Box marginTop={1}>
          <Text color={FAINT}>◓ reading definitions …</Text>
        </Box>
      ) : loadError ? (
        <Box marginTop={1}>
          <Text color={AMBER}>{`▲ definitions unreadable — ${truncateToWidth(loadError, 52)}`}</Text>
        </Box>
      ) : list.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState
            glyph="○"
            title={query ? 'nothing matches' : 'no agents in this view'}
            hint={query ? 'different words, or esc clears' : 'N creates one · tab widens the scope'}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <SectionHeader count={list.length}>Agents</SectionHeader>
          {above > 0 ? <Text color={FAINT}>{`  +${above} above`}</Text> : null}
          {visible.map((row, i) => {
            const active = i === clampedSel
            if (row.kind === 'invalid') {
              return (
                <Text key={row.id}>
                  <Text color={active ? accent : FAINT}>{active ? '▸ ' : '  '}</Text>
                  <Text color={CRIMSON}>▲ </Text>
                  <Text color={SECOND}>{truncateToWidth(`invalid: ${row.invalid!.path.split(/[\\/]/).slice(-2).join('/')} — ${row.invalid!.error}`, 70)}</Text>
                </Text>
              )
            }
            const agent = row.agent!
            const disabled = agent.disabled === true
            const glyph = disabled ? '○' : row.shadowed ? '◌' : '●'
            const glyphColor = disabled ? FAINT : row.shadowed ? AMBER : TEAL
            return (
              <Text key={row.id}>
                <Text color={active ? accent : FAINT}>{active ? '▸ ' : '  '}</Text>
                <Text color={glyphColor}>{`${glyph} `}</Text>
                <Text color={disabled ? FAINT : IVORY}>{agent.agentType.padEnd(24)}</Text>
                <Text color={FAINT}>{SOURCE_SHORT[agent.source].padEnd(9)}</Text>
                <Text color={agent.operatorOverride ? AMBER : SECOND}>
                  {truncateToWidth(
                    `${agent.model ?? 'inherit'}${agent.operatorOverride ? ' (override)' : ''}${row.shadowed ? ' · shadowed' : ''}`,
                    30,
                  )}
                </Text>
              </Text>
            )
          })}
          {below > 0 ? <Text color={FAINT}>{`  +${below} more below`}</Text> : null}
        </Box>
      )}
    </Box>
  )
}

function InspectorPane({
  row,
  estate,
  parentModel,
  sessionEffort,
  tools,
}: {
  row: StudioRow
  estate: Map<string, AgentEstateEntry>
  parentModel: string
  sessionEffort: Parameters<typeof resolveEffectiveAgentRuntime>[1]['sessionEffort']
  tools: Tools
}): React.ReactNode {
  if (row.kind === 'invalid') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <StateBadge state="gated" label="invalid definition" />
        <Text color={IVORY}>{row.invalid!.path}</Text>
        <Text color={CRIMSON}>{row.invalid!.error}</Text>
        <Text color={FAINT}>the file stays visible until it parses — o opens it in your editor</Text>
      </Box>
    )
  }
  const agent = row.agent!
  const eff = resolveEffectiveAgentRuntime(agent, {
    parentModel,
    sessionEffort,
    tools,
  })
  const entry = estate.get(agent.agentType)
  const line = (k: string, v: string, tone: string = IVORY): React.ReactNode => (
    <Text key={k}>
      <Text color={FAINT}>{k.padEnd(13)}</Text>
      <Text color={tone}>{truncateToWidth(v, 62)}</Text>
    </Text>
  )
  return (
    <Box flexDirection="column" marginTop={1} gap={0}>
      <Box>
        <StateBadge
          state={agent.disabled ? 'gated' : 'live'}
          label={`${agent.agentType}${agent.disabled ? ' (disabled)' : ''}`}
        />
      </Box>
      {line(
        'path',
        (agent as { filePath?: string }).filePath ??
          (agent.source === 'built-in' ? 'built-in (no file)' : agent.source === 'extension' ? `extension: ${(agent as { extensionName?: string }).extensionName ?? '?'}` : 'in-memory (--agent-defs flag)'),
      )}
      {(agent as { revision?: string }).revision
        ? line('revision', (agent as { revision?: string }).revision!)
        : null}
      {line('scope', getAgentSourceDisplayName(agent.source))}
      {line('description', agent.whenToUse.replace(/\n/g, ' '))}
      {line(
        'model',
        `${eff.modelIntent} → ${eff.model}${agent.operatorOverride?.model ? ` · override(${agent.operatorOverride.from})` : ''}`,
        TEAL,
      )}
      {(() => {
        const availability = agentModelAvailabilityNote(agent.operatorOverride?.model ?? agent.model)
        return availability !== null ? line('availability', `${availability} — /logins signs in`, AMBER) : null
      })()}
      {line(
        'effort',
        `${eff.effortIntent !== undefined ? `${eff.effortIntent} → ` : 'session → '}${eff.effort.label}${eff.effort.adjustedFrom ? ` (requested ${eff.effort.adjustedFrom})` : ''}`,
        TEAL,
      )}
      {eff.tools
        ? line(
            'tools',
            eff.tools.readOnly
              ? SCOUT_TOOLS_DESCRIPTION
              : eff.tools.hasWildcard
              ? 'all session tools'
              : `${eff.tools.validTools.length} of the session catalog${eff.tools.invalidTools.length > 0 ? ` · unknown: ${eff.tools.invalidTools.join(', ')}` : ''}`,
            eff.tools.invalidTools.length > 0 ? AMBER : IVORY,
          )
        : null}
      {agent.skills && agent.skills.length > 0 ? line('skills', agent.skills.join(', ')) : null}
      {agent.memory ? line('memory', agent.memory) : null}
      {agent.mcpServers ? line('mcp', `${agent.mcpServers.length} server ref(s)`) : null}
      {entry && entry.candidates.length > 1 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>shadow chain:</Text>
          {entry.candidates.map((c, i) => (
            <Text key={i} color={c.winner ? TEAL : FAINT}>
              {truncateToWidth(
                `  ${c.winner ? '● wins' : `◌ ${c.shadowReason ?? 'shadowed'}`} — ${getAgentSourceDisplayName(c.agent.source)}${(c.agent as { filePath?: string }).filePath ? ` · ${(c.agent as { filePath?: string }).filePath}` : ''}`,
                76,
              )}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

function TestDrivePane({
  agent,
  buffer,
  onChange,
  onSubmit,
  parentModel,
  sessionEffort,
  tools,
}: {
  agent: AgentDefinition
  buffer: string
  onChange: (v: string) => void
  onSubmit: () => void
  parentModel: string
  sessionEffort: Parameters<typeof resolveEffectiveAgentRuntime>[1]['sessionEffort']
  tools: Tools
}): React.ReactNode {
  const eff = resolveEffectiveAgentRuntime(agent, { parentModel, sessionEffort, tools })
  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionHeader>{`Test drive ${agent.agentType}`}</SectionHeader>
      <Text color={FAINT}>
        {truncateToWidth(
          `will run: model ${eff.model} · effort ${eff.effort.label} · ${eff.tools?.readOnly ? 'read-only tools' : eff.tools?.hasWildcard ? 'all tools' : `${eff.tools?.validTools.length ?? 0} tools`} · revision ${(agent as { revision?: string }).revision ?? 'in-memory'} · disposable worktree`,
          78,
        )}
      </Text>
      <Text color={FAINT}>small prompt for the drive (lands in the composer for your review — never auto-runs):</Text>
      <TextInput
        value={buffer}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="e.g. summarize what this repository does"
        columns={78}
        cursorOffset={buffer.length}
        onChangeCursorOffset={() => {}}
        focus
        showCursor
      />
      <Text color={FAINT}>↵ stage in composer · esc cancel</Text>
    </Box>
  )
}

function TrashView({ sel }: { sel: number }): React.ReactNode {
  const entries = listAgentTrash()
  const win = popupListWindow(entries.length, sel, 10)
  if (entries.length === 0) {
    return (
      <Box marginTop={1}>
        <EmptyState glyph="○" title="trash is empty" hint="deleted agents land here, restorable" />
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionHeader count={entries.length}>Deleted agents (restorable)</SectionHeader>
      <PopupListViewport above={win.above} below={win.below} rows={win.end - win.start}>
      {entries.slice(win.start, win.end).map((e, index) => {
        const i = win.start + index
        return (
        <Text key={e.id}>
          <Text color={i === Math.min(sel, entries.length - 1) ? TEAL : FAINT}>
            {i === Math.min(sel, entries.length - 1) ? '▸ ' : '  '}
          </Text>
          <Text color={IVORY}>{e.agentType.padEnd(24)}</Text>
          <Text color={FAINT}>{truncateToWidth(`${e.deletedAt.slice(0, 16)} · was ${e.originalPath}`, 48)}</Text>
        </Text>
      )})}
      </PopupListViewport>
    </Box>
  )
}
