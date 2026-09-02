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
  setAgentDisabled,
  setAgentOverride,
} from '../../../services/agents/overrides.js'
import {
  decodeAgentDocument,
  patchAgentDocument,
  serializeAgentMarkdown,
} from '../../../services/agents/codec.js'
import { saveAgentDocument } from '../../../services/agents/store.js'
import { useAppState, useSetAppState } from '../../../state/AppState.js'
import type { AppState } from '../../../state/AppStateStore.js'
import type { Tools } from '../../../Tool.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../../utils/cwd.js'
import { editFileInEditor } from '../../../utils/promptEditor.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import {
  CommandCenter,
  EmptyState,
  SectionHeader,
  StateBadge,
} from '../../mercury-ui/components.js'
import { GLYPH, truncateToWidth } from '../../mercury-ui/glyphs.js'
import { useSessionAccent } from '../../mercury-ui/sessionAccent.js'
import { useFlatList } from '../../mercury-ui/useFlatList.js'
import { useMainLoopModel } from '../../../hooks/useMainLoopModel.js'
import TextInput from '../../TextInput.js'
import { getAgentSourceDisplayName } from '../utils.js'
import { StudioEditor, type StudioDraftBase } from './StudioEditor.js'
import { ModelSelector } from '../ModelSelector.js'
import { agentModelAvailabilityNote } from '../../../utils/model/agentModelPicker.js'
import {
  buildStudioRows,
  isFileBacked,
  SCOPE_TABS,
  STATUS_FILTERS,
  type StudioRow,
  type StudioScopeTab,
  type StudioStatusFilter,
} from './studioData.js'
import { readFileSync } from 'node:fs'

// ============================================================================
//  AgentStudio — the ONE native product surface for agent definitions
//  (/agents; /agent-form is a thin alias opening create mode).
//
// closure shape (brief): a library with fuzzy search, scope
//  tabs, status filters, exact-identity inspector (path · revision ·
//  provenance · shadow chain · effective runtime), rapid enable/disable and
//  per-agent overrides, create/clone/edit/test-drive/delete/restore —
//  every write through the transactional store, every reload through the ONE
//  AppState refresh.
//
//  Grammar (the /memory-centre idiom): useFlatList(charKeys:false) owns
//  ↑↓/↵/esc; lowercase letters type into the live search; UPPERCASE letters
//  + Space/Tab are the library verbs; the inspector (a detail mode without
//  search) uses lowercase verbs.
// ============================================================================

type Mode =
  | { kind: 'library' }
  | { kind: 'inspect'; row: StudioRow }
  | { kind: 'create' }
  | { kind: 'edit'; base: StudioDraftBase }
  | { kind: 'delete-confirm'; agent: AgentDefinition }
  | { kind: 'trash' }
  | { kind: 'clone'; agent: AgentDefinition; buffer: string }
  | { kind: 'testdrive'; agent: AgentDefinition; buffer: string }
  | { kind: 'override-model'; agent: AgentDefinition }

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
  const parentModel = useMainLoopModel()
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
  React.useEffect(() => {
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

  // ── library input: search chars + verbs (uppercase/space/tab) ─────────────
  useInput(
    (input, key) => {
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
        // Rapid enable/disable (user scope) — built-ins: silent no-op, and the
        // footer sheds `Space toggle` while a built-in row is selected.
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
    },
    { isActive: mode.kind === 'library' },
  )

  // ── inspector verbs ───────────────────────────────────────────────────────
  const inspected = mode.kind === 'inspect' ? mode.row : null
  useInput(
    (input, key) => {
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
      // Ungated verbs below are SILENT no-ops on rows they can't apply to —
      // the footer (inspectFooter) only advertises what the row supports, so
      // a dead key is never advertised and a refusal note is never needed
      // (pass; the old notes advertised-then-refused, and
      // the `e` refusal even kicked the operator back to the library).
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
        // The model-override picker over THE ONE catalogue (the
        // neutrality mandate: the old opus→sonnet→fable hard cycle
        // privileged one family's spellings and hid every other provider;
        // the picker offers the full catalogue in its own order, and the
        // Inherit row clears the override).
        setMode({ kind: 'override-model', agent })
        return
      }
    },
    { isActive: mode.kind === 'inspect' },
  )

  // ── delete-confirm input ──────────────────────────────────────────────────
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

  // ── clone / testdrive text entry ──────────────────────────────────────────
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
        `effective model ${eff.model}, effort ${eff.effort.label}): spawn it with the Agent tool ` +
        `(subagent_type: "${agent.agentType}", isolation: "worktree" so it works in a disposable copy) ` +
        `on this prompt, then report its result and whether it matched the definition's intent:\n\n${prompt}`
      onExit(undefined, { display: 'skip', nextInput })
    },
    [parentModel, sessionEffort, mergedTools, onExit],
  )

  // ── trash mode ────────────────────────────────────────────────────────────
  const [trashSel, setTrashSel] = React.useState(0)
  useInput(
    (input, key) => {
      if (mode.kind !== 'trash') return
      const entries = listAgentTrash()
      if (key.escape || key.leftArrow) {
        setMode({ kind: 'library' })
        return
      }
      if (key.upArrow) setTrashSel(s => Math.max(0, s - 1))
      else if (key.downArrow) setTrashSel(s => Math.min(Math.max(0, entries.length - 1), s + 1))
      else if (key.return || input === 'u') {
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

  // ── renders ───────────────────────────────────────────────────────────────

  if (mode.kind === 'override-model') {
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

  if (mode.kind === 'create' || mode.kind === 'edit') {
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

  // honesty: the inspect footer composes from the SAME predicates that arm
  // the verbs above — an affordance named is an affordance wired; ungated
  // keys are silent no-ops.
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
  // The clone and test-drive fields own the keys while they show: their
  // footers name the two moves that work there, never the library's letters
  // (N/U/R would be typing into the field, and there is no search to type
  // into) — a printed key that does not fire is a lie.
  const footer =
    mode.kind === 'inspect'
      ? inspected?.kind === 'invalid'
        ? 'o open in editor · esc back'
        : inspected?.agent
          ? inspectFooter(inspected.agent)
          : 'esc back'
      : mode.kind === 'trash'
        ? '↑↓ move · ↵/u restore · esc back'
        : mode.kind === 'delete-confirm'
          ? 'y / ↵ delete (recoverable) · n / esc cancel'
          : mode.kind === 'clone'
            ? '↵ clone under the new identifier · esc back'
            : mode.kind === 'testdrive'
              ? '↵ stage in composer · esc cancel'
              : query
                ? '↑↓ move · ↵ inspect · esc clear search'
                : `type to search · ↑↓ · ↵ inspect · ${librarySpace}N new · U trash · R reload · tab scope · shift+tab filter · esc close`

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
    >
      <Box flexDirection="column">
        {mode.kind === 'delete-confirm' ? (
          <Box marginTop={1} flexDirection="column">
            <SectionHeader>Delete agent</SectionHeader>
            <Text>
              <Text color={IVORY}>{`delete ${mode.agent.agentType}? `}</Text>
              <Text color={FAINT}>
                {`the file moves to the recovery area (restore with U) — never a permanent unlink`}
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

// ── panes ────────────────────────────────────────────────────────────────────

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
          (agent.source === 'built-in' ? 'built-in (no file)' : agent.source === 'extension' ? `extension: ${(agent as { extensionName?: string }).extensionName ?? '?'}` : 'in-memory (--agents flag)'),
      )}
      {(agent as { revision?: string }).revision
        ? line('revision', (agent as { revision?: string }).revision!)
        : null}
      {line('scope', getAgentSourceDisplayName(agent.source))}
      {line('description', agent.whenToUse.replace(/\n/g, ' '))}
      {line(
        'model',
        `${eff.modelIntent} → ${eff.model}${eff.flooredFrom ? ` (floored from ${eff.flooredFrom})` : ''}${agent.operatorOverride?.model ? ` · override(${agent.operatorOverride.from})` : ''}`,
        TEAL,
      )}
      {(() => {
        // Availability is a session fact — worn, never a refusal (C6).
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
            eff.tools.hasWildcard
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
          `will run: model ${eff.model} · effort ${eff.effort.label} · ${eff.tools?.hasWildcard ? 'all tools' : `${eff.tools?.validTools.length ?? 0} tools`} · revision ${(agent as { revision?: string }).revision ?? 'in-memory'} · disposable worktree`,
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
      {entries.slice(0, 10).map((e, i) => (
        <Text key={e.id}>
          <Text color={i === Math.min(sel, entries.length - 1) ? TEAL : FAINT}>
            {i === Math.min(sel, entries.length - 1) ? '▸ ' : '  '}
          </Text>
          <Text color={IVORY}>{e.agentType.padEnd(24)}</Text>
          <Text color={FAINT}>{truncateToWidth(`${e.deletedAt.slice(0, 16)} · was ${e.originalPath}`, 48)}</Text>
        </Text>
      ))}
    </Box>
  )
}
