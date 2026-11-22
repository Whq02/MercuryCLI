import * as React from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import type { CommandResultDisplay } from '../../../commands.js'
import { useMergedTools } from '../../../hooks/useMergedTools.js'
import { reloadAgentDefinitionsIntoAppState } from '../../../hooks/useAgentsChange.js'
import {
  type AgentEstateEntry,
  resolveEffectiveAgentRuntime,
} from '../../../services/agents/resolver.js'
import {
  AgentStoreError,
  deleteAgentToTrash,
  listAgentTrash,
  restoreAgentFromTrash,
} from '../../../services/agents/store.js'
import {
  decodeAgentDocument,
  patchAgentDocument,
  serializeAgentMarkdown,
} from '../../../services/agents/codec.js'
import { saveAgentDocument } from '../../../services/agents/store.js'
import { useAppState, useSetAppState } from '../../../state/AppState.js'
import type { AppState } from '../../../state/AppStateStore.js'
import type { Tools } from '../../../Tool.js'
import type { AgentDefinition } from '../../../types/agent.js'
import { SCOUT_TOOLS_DESCRIPTION } from '../../../tools/AgentTool/scoutPolicy.js'
import { getCwd } from '../../../utils/cwd.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import {
  EmptyState,
  SectionHeader,
  StateBadge,
} from '../../mercury-ui/components.js'
import { truncateToWidth } from '../../../utils/glyphs.js'
import { useSessionAccent } from '../../mercury-ui/sessionAccent.js'
import { useFlatList } from '../../mercury-ui/useFlatList.js'
import { popupListWindow, PopupListViewport, usePopupListNavigation } from '../../CustomSelect/popup-list.js'
import { useEngineModel } from '../../../hooks/useEngineModel.js'
import { usePublish } from '../../../hooks/effects.js'
import TextInput from '../../TextInput.js'
import { getAgentSourceDisplayName } from '../utils.js'
import { agentModelAvailabilityNote } from '../../../services/model/agentModelPicker.js'
import {
  buildStudioRows,
  isFileBacked,
  type StudioRow,
  type StudioScopeTab,
  type StudioStatusFilter,
} from './studioData.js'
import { readFileSync } from 'node:fs'
import { inspectKeysOf, libraryKeysOf, modelOverrideView, studioEditorPane, studioLibraryView, type Mode } from './agentStudioParts.js'
import { notBuilt } from '../../../pi/holes.js'


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

export function AgentStudio(arg0: Props): React.ReactNode {
  return notBuilt('src/components/agents/studio/AgentStudio.tsx:75')
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
