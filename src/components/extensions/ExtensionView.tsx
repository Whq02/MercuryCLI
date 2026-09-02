// ============================================================================
//  ExtensionView — one extension's full page (spec 05 §5): health with its
//  reasons, provenance, approval, update; every contribution kind on its
//  own line with its own switch letter; needs; data. The facts come from
//  the roster entry + the one health owner + the core's resolver — the
//  view derives nothing, and the kind letters write through the core's
//  setKindSwitch. esc returns to the board with the cursor kept.
// ============================================================================
import * as React from 'react'
import { existsSync } from 'node:fs'
import { Box, Text, useInput } from '../../ink.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import ScrollBox from '../../ink/components/ScrollBox.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getRuntimeFacts } from '../../extensions/active.js'
import { setKindSwitch } from '../../extensions/install.js'
import { realProbes, resolveContributions, type Resolution } from '../../extensions/load/contributions.js'
import { type SwitchKind } from '../../extensions/manifest.js'
import { isOptionSet } from '../../extensions/options.js'
import { getExtensionDataDir } from '../../extensions/paths.js'
import { trustStateOf } from '../../extensions/roster.js'
import { defaultSwitches } from '../../extensions/records.js'
import { folderSize } from '../../extensions/tree.js'
import type { Health, RosterEntry } from '../../extensions/types.js'
import { decodeNavKey } from '../mercury-ui/navSemantics.js'
import { ProductLockup } from '../mercury-ui/components.js'
import { packFooter } from '../mercury-ui/footerHint.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import { charWord, resolveExtensionsBindings } from './bindings.js'
import { trustWord } from './rowWords.js'

const KIND_LETTER: Record<SwitchKind, string> = {
  skills: 's',
  agents: 'g',
  hooks: 'h',
  servers: 'm',
  language: 'l',
  channels: 'c',
  keybindings: 'k',
}

function bytesWord(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function ExtensionView({
  entry,
  health,
  onBack,
  onToggle,
  onUpdate,
  onUninstall,
  onOptions,
  onBlock,
  onPrevious,
  onRefreshRoster,
}: {
  entry: RosterEntry
  health: Health | null
  onBack: () => void
  onToggle: () => void
  onUpdate: () => void
  onUninstall: () => void
  onOptions: () => void
  onBlock: () => void
  onPrevious: () => void
  /** After a kind switch writes, the roster repaints through the one slice. */
  onRefreshRoster: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns: cols, rows: termRows } = useTerminalSize()
  const pastGate = useOpenEventGate()
  // The same ONE dispatch resolution the board uses (05 §2.3).
  const kb = React.useMemo(() => resolveExtensionsBindings(), [])
  const kchar = (action: string): string | null => kb.chars.get(`extensions:${action}`) ?? null

  const bundled = entry.home === 'bundled'
  const state = trustStateOf(entry)
  const w = trustWord(state, health)
  const switches = entry.record?.switches ?? defaultSwitches()

  // The resolver — the same primitive the card and the health owner read
  // (an off row has no health entry; its contributions still list).
  const resolution: Resolution | null = React.useMemo(() => {
    if (entry.manifest === null || entry.root === null) return null
    return resolveContributions(
      entry.manifest,
      entry.root,
      entry.id,
      realProbes({ optionSet: key => isOptionSet(entry.id, entry.manifest?.needs?.options, key) }),
    )
  }, [entry.manifest, entry.root, entry.id, entry.contributionsHash])

  const toggleKind = (kind: SwitchKind): void => {
    if (entry.record === null) return
    const out = setKindSwitch(entry.id, kind, !switches[kind])
    if (out.ok) onRefreshRoster()
  }

  useInput((input, key) => {
    const action = decodeNavKey(input, key, { orientation: 'vertical', hierarchy: true })
    if (action === 'cancel' || action === 'leaveChild') {
      onBack()
      return
    }
    // Modifier chords never fire single-char actions (the chassis's law —
    // ctrl+c must stay the interrupt, never a 'c').
    if (key.ctrl || key.meta) return
    if (!pastGate()) return
    if (input === '') return
    if (input === kchar('toggle') && (entry.record !== null || bundled)) {
      onToggle()
      return
    }
    const kind = (Object.entries(KIND_LETTER).find(([, letter]) => letter === input)?.[0] ?? null) as SwitchKind | null
    if (kind !== null && entry.record !== null && declared(kind)) {
      toggleKind(kind)
      return
    }
    if (bundled) return
    if (input === kchar('update') && entry.availableVersion !== null && entry.home === 'installed') onUpdate()
    else if (input === kchar('options') && Object.keys(entry.manifest?.needs?.options ?? {}).length > 0) onOptions()
    else if (input === kchar('remove') && (entry.home === 'installed' || (entry.home === 'project' && entry.record !== null))) onUninstall()
    else if (input === kchar('block') && entry.blockedBy !== 'policy') onBlock()
    else if (input === kchar('previous') && entry.previous !== null) onPrevious()
  })

  const declared = (kind: SwitchKind): boolean => {
    if (resolution === null) return false
    if (kind === 'skills') return resolution.skills.length > 0 || resolution.commands.length > 0
    if (kind === 'agents') return resolution.agents.length > 0
    if (kind === 'hooks') return resolution.hooks.length > 0
    if (kind === 'servers') return resolution.servers.length > 0
    if (kind === 'language') return resolution.language.length > 0
    if (kind === 'channels') return resolution.channels.length > 0
    return resolution.keybindings.length > 0
  }

  // ── the adds lines (05 §5) ────────────────────────────────────────────────
  const runtimeFacts = getRuntimeFacts()
  const addLines: Array<{ kind: SwitchKind; what: string }> = []
  if (resolution) {
    const skills = [...resolution.skills.map(s => `/${s.name}`), ...resolution.commands.map(c => `/${c.name}`)]
    if (skills.length > 0) addLines.push({ kind: 'skills', what: skills.join(' · ') })
    if (resolution.agents.length > 0) addLines.push({ kind: 'agents', what: resolution.agents.map(a => a.agentType).join(' · ') })
    for (const hook of resolution.hooks) {
      addLines.push({ kind: 'hooks', what: `${hook.event}${hook.matcher ? `  ${hook.matcher}` : ''}  →  ${shortRoot(hook.commandLine, entry.root)}${hook.hook.timeout ? `  (${hook.hook.timeout}s)` : ''}` })
    }
    for (const server of resolution.servers) {
      const config = server.config
      const line =
        'command' in config ? `${config.command}${config.args?.length ? ` ${config.args.join(' ')}` : ''}` : `${config.type} ${config.url}`
      const live = runtimeFacts.servers?.get(server.runtimeName)
      const liveWord = live
        ? `  ·  ${live.state}${live.toolCount !== undefined ? `  ·  ${live.toolCount} tool${live.toolCount === 1 ? '' : 's'}` : ''}`
        : ''
      addLines.push({ kind: 'servers', what: `${server.key}  →  ${shortRoot(line, entry.root)}${liveWord}` })
    }
    for (const language of resolution.language) {
      const config = language.config
      const line = `${config.command}${config.args?.length ? ` ${config.args.join(' ')}` : ''}  ·  ${Object.keys(config.extensionToLanguage).join(' ')}`
      addLines.push({ kind: 'language', what: `${language.key}  →  ${shortRoot(line, entry.root)}` })
    }
    for (const channel of resolution.channels) addLines.push({ kind: 'channels', what: `${channel.label}  (server ${channel.server})` })
    for (const binding of resolution.keybindings) {
      addLines.push({ kind: 'keybindings', what: `${binding.chord}  →  ${binding.target}  ·  ${binding.taken ? 'chord is taken — inert' : 'chord is yours'}` })
    }
  }

  const needs = entry.manifest?.needs
  const probes = React.useMemo(() => realProbes({ optionSet: key => isOptionSet(entry.id, needs?.options, key) }), [entry.id, entry.contributionsHash])
  const dataDir = entry.home === 'installed' ? getExtensionDataDir(entry.id) : null
  const dataBytes = dataDir && existsSync(dataDir) ? folderSize(dataDir) : 0

  const hint = (action: string, label: string, armed: boolean): string | null => {
    const char = kchar(action)
    return armed && char !== null ? `${charWord(char)} ${label}` : null
  }
  const footerParts = [
    hint('toggle', entry.switchedOn ? 'off' : 'on', entry.record !== null || bundled),
    hint('update', 'update', !bundled && entry.availableVersion !== null && entry.home === 'installed'),
    hint('options', 'options', !bundled && Object.keys(needs?.options ?? {}).length > 0),
    hint('remove', 'uninstall', !bundled && (entry.home === 'installed' || (entry.home === 'project' && entry.record !== null))),
    hint('block', entry.blockedBy === 'operator' ? 'unblock' : 'block', !bundled && entry.blockedBy !== 'policy'),
    hint('previous', 'previous', !bundled && entry.previous !== null),
    entry.record !== null && addLines.length > 0
      ? `${[...new Set(addLines.map(l => KIND_LETTER[l.kind]))].join(' ')} toggle a kind`
      : null,
    'esc back',
  ].filter(Boolean)

  const bodyHeight = Math.max(3, termRows - 6)

  return (
    <AlternateScreen>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tokens.accent}
        paddingX={1}
        width="100%"
        flexShrink={0}
        minHeight={Math.max(0, termRows - 1)}
      >
        <Box flexShrink={0} height={1} overflow="hidden">
          <ProductLockup view="extensions" subtitle={`${entry.name} ${entry.version}`} />
          <Box flexGrow={1} />
          <Text color={tokens.textMuted} wrap="truncate-end">
            from {entry.home === 'project' ? 'this project' : entry.label}
          </Text>
        </Box>
        <ScrollBox height={bodyHeight} flexShrink={0} flexDirection="column">
          <Box flexDirection="column" marginTop={1}>
            <Fact k="health">
              <Text color={tokens[w.role]}>
                {w.glyph} {w.word || 'not installed'}
              </Text>
              {state === 'on' && (health?.reasons.length ?? 0) === 0 ? <Text color={tokens.textMuted}> · loads</Text> : null}
            </Fact>
            {(health?.reasons ?? []).map((reason, i) => (
              <Fact key={`reason-${i}`} k="">
                <Text color={tokens[w.role]}>{reason}</Text>
              </Fact>
            ))}
            {(health?.notes ?? []).map((noteLine, i) => (
              <Fact key={`note-${i}`} k="">
                <Text color={tokens.textMuted}>{noteLine}</Text>
              </Fact>
            ))}
            <Fact k="from">
              <Text color={tokens.textPrimary} wrap="truncate-end">
                {entry.home === 'project'
                  ? `this project · ${entry.root ?? ''}`
                  : entry.home === 'session'
                    ? `--extension · ${entry.root ?? ''}`
                    : entry.home === 'bundled'
                      ? 'bundled with Mercury'
                      : `${entry.label}${entry.source?.where ? ` · ${entry.source.where}` : ''}${entry.record?.commit ? ` · commit ${entry.record.commit.slice(0, 7)}` : ''}${entry.record ? ` · installed ${entry.record.installedAt.slice(0, 10)}` : ''}`}
              </Text>
            </Fact>
            <Fact k="approved">
              {entry.record?.approval ? (
                <Text color={tokens.textPrimary}>
                  {entry.record.approval.at.slice(0, 10)} for {entry.record.approval.version} · switch:{' '}
                  {entry.switchScope === 'project' ? 'this project' : entry.switchScope === 'everywhere' ? 'everywhere' : 'off'}
                  {entry.changedSinceApproval ? <Text color={tokens.warning}> · changed — re-approve</Text> : null}
                </Text>
              ) : bundled ? (
                <Text color={tokens.textPrimary}>installing Mercury is the approval</Text>
              ) : (
                <Text color={tokens.textMuted}>not approved · i approves on the board</Text>
              )}
            </Fact>
            {entry.availableVersion ? (
              <Fact k="update">
                <Text color={tokens.warning}>↑ {entry.availableVersion} available · U applies</Text>
              </Fact>
            ) : null}
            {entry.previous ? (
              <Fact k="previous">
                <Text color={tokens.textMuted}>{entry.previous.version} kept · P swaps back</Text>
              </Fact>
            ) : null}

            {/* The frame's interior is cols − 4 (border + padding each side); the
                rule runs to the padding, not two cells short of it. */}
            <SectionRule label="adds" width={cols - 4} />
            {addLines.length === 0 ? (
              <Text color={tokens.textMuted}>  nothing — the manifest declares no contributions</Text>
            ) : (
              addLines.map((line, i) => {
                const on = switches[line.kind]
                return (
                  <Box key={i} height={1} overflow="hidden">
                    <Box width={2} flexShrink={0}>
                      <Text color={on ? tokens.success : tokens.textMuted}>{on ? '●' : '○'}</Text>
                    </Box>
                    <Box width={13} flexShrink={0}>
                      <Text color={tokens.textSecondary}>{line.kind}</Text>
                    </Box>
                    <Box flexGrow={1} overflow="hidden">
                      <Text color={tokens.textPrimary} wrap="truncate-end">
                        {line.what}
                      </Text>
                    </Box>
                    <Box flexShrink={0} marginLeft={1}>
                      <Text color={tokens.textMuted}>
                        {on ? 'on ' : 'off'} {entry.record !== null ? KIND_LETTER[line.kind] : ' '}
                      </Text>
                    </Box>
                  </Box>
                )
              })
            )}

            <SectionRule label="needs" width={cols - 4} />
            {needs?.binaries?.length ? (
              <Fact k="binaries">
                <Text color={tokens.textPrimary}>
                  {needs.binaries.map(b => `${b} ${probes.onPath(b) ? '✓' : '✕ not on PATH'}`).join('  ·  ')}
                </Text>
              </Fact>
            ) : null}
            {needs?.env?.length ? (
              <Fact k="env">
                <Text color={tokens.textPrimary}>{needs.env.map(e => `${e} ${probes.envSet(e) ? '✓ set' : '✕ unset'}`).join('  ·  ')}</Text>
              </Fact>
            ) : null}
            {needs?.network?.length ? (
              <Fact k="network">
                <Text color={tokens.textPrimary}>{needs.network.join(' · ')}</Text>
              </Fact>
            ) : null}
            {Object.keys(needs?.options ?? {}).length > 0 ? (
              <Fact k="options">
                <Text color={tokens.textPrimary}>
                  {Object.entries(needs?.options ?? {})
                    .map(([key, option]) => `${key}${option.sensitive ? ' (sensitive)' : ''} ${isOptionSet(entry.id, needs?.options, key) ? '✓ set' : '· unset'}`)
                    .join('  ·  ')}
                  {!bundled ? <Text color={tokens.textMuted}>       o edits</Text> : null}
                </Text>
              </Fact>
            ) : null}
            {!needs?.binaries?.length && !needs?.env?.length && !needs?.network?.length && Object.keys(needs?.options ?? {}).length === 0 ? (
              <Text color={tokens.textMuted}>  nothing</Text>
            ) : null}

            {dataDir ? (
              <Box marginTop={1}>
                <Fact k="data">
                  <Text color={tokens.textPrimary}>
                    {dataBytes > 0 ? `${bytesWord(dataBytes)} · ` : ''}
                    {dataDir}
                  </Text>
                </Fact>
              </Box>
            ) : null}
          </Box>
        </ScrollBox>
        <Box flexGrow={1} />
        <Box marginTop={1} flexShrink={0} height={1} overflow="hidden">
          <Text color={tokens.textMuted} wrap="truncate-end">
            {packFooter(footerParts.join(' · '), Math.max(0, cols - 4))}
          </Text>
        </Box>
      </Box>
    </AlternateScreen>
  )
}

function shortRoot(line: string, root: string | null): string {
  return root ? line.split(root).join('<root>') : line
}

function Fact({ k, children }: { k: string; children: React.ReactNode }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Box height={1} overflow="hidden">
      <Box width={11} flexShrink={0}>
        <Text color={tokens.textMuted}>{k}</Text>
      </Box>
      <Box flexGrow={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  )
}

function SectionRule({ label, width }: { label: string; width: number }): React.ReactNode {
  const tokens = useMercuryTokens()
  const rule = '─'.repeat(Math.max(0, Math.min(width - label.length - 1, 200)))
  return (
    <Box marginTop={1} height={1} overflow="hidden">
      <Text color={tokens.textSecondary} bold>
        {label}{' '}
      </Text>
      <Text color={tokens.borderSubtle}>{rule}</Text>
    </Box>
  )
}
