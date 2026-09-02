import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import {
  IdeAutoConnectDialog,
  IdeDisableAutoConnectDialog,
  shouldShowAutoConnectDialog,
  shouldShowDisableAutoConnectDialog,
} from '../../components/IdeAutoConnectDialog.js'
import { Select } from '../../components/CustomSelect/select.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { useAppState } from '../../state/AppState.js'
import { clearServerCache } from '../../services/mcp/client.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  detectIDEs,
  detectRunningIDEs,
  isJetBrainsIde,
  isSupportedTerminal,
  toIDEDisplayName,
  type DetectedIDEInfo,
  type IdeType,
} from '../../utils/ide.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getCwd } from '../../utils/cwd.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

/** IDE-owned tool/command prefix (contract data). */
const IDE_TOOL_PREFIX = 'mcp__ide__'

/** Chosen to sit just above the MCP layer's own 30 s connection timeout, so
 *  the MCP outcome normally arrives first and this is the fallback. */
const CONNECT_TIMEOUT_MS = 35_000

/**
 * Workspace folders for display: at most the first two, cwd prefix
 * stripped (both sides NFC — macOS paths arrive decomposed), each fitted to
 * an even share of the budget with the TAIL kept (the informative end of a
 * path), and a `, …` marker when more exist.
 */
export function formatWorkspaceFolders(folders: string[], maxLength: number = 100): string {
  if (folders.length === 0) return ''
  const shown = folders.slice(0, 2)
  const truncatedList = folders.length > shown.length
  const separatorOverhead = (shown.length - 1) * 2
  const ellipsisOverhead = truncatedList ? 3 : 0
  const budget = Math.floor((maxLength - separatorOverhead - ellipsisOverhead) / shown.length)
  const cwdPrefix = getCwd().normalize('NFC')
  const parts = shown.map(folder => {
    let display = folder
    const normalized = folder.normalize('NFC')
    if (normalized.startsWith(`${cwdPrefix}/`) || normalized.startsWith(`${cwdPrefix}\\`)) {
      display = normalized.slice(cwdPrefix.length + 1)
    }
    if (display.length > budget && budget > 1) {
      display = `…${display.slice(-(budget - 1))}`
    }
    return display
  })
  return truncatedList ? `${parts.join(', ')}, …` : parts.join(', ')
}

function isVSCodeFamilyName(name: string): boolean {
  const lowered = name.toLowerCase()
  return lowered.includes('vscode') || lowered.includes('cursor') || lowered.includes('windsurf')
}

// ── `open` sub-verb ─────────────────────────────────────────────────────────

function IdeOpenPicker({
  ides,
  targetPath,
  targetKind,
  onDone,
}: {
  ides: DetectedIDEInfo[]
  targetPath: string
  targetKind: 'worktree' | 'project'
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const options = [
    ...ides.map(ide => ({ label: ide.name, value: String(ide.port) })),
    { label: 'None', value: 'none' },
  ]
  return (
    <Dialog
      title={`Open ${targetKind} in IDE`}
      onCancel={() => onDone('Exited without opening IDE', { display: 'system' })}
    >
      <Select
        options={options}
        onChange={value => {
          if (value === 'none') {
            onDone('No IDE selected')
            return
          }
          const ide = ides.find(candidate => String(candidate.port) === value)
          if (!ide) {
            onDone('No IDE selected')
            return
          }
          void (async () => {
            if (isVSCodeFamilyName(ide.name)) {
              const outcome = await execFileNoThrow('code', [targetPath])
              onDone(
                outcome.code === 0
                  ? `Opened ${targetKind} in ${ide.name}`
                  : `Could not launch ${ide.name} — open ${targetPath} in it manually.`,
              )
              return
            }
            // JetBrains-terminal and general arms produce the same message.
            onDone(`Open ${targetPath} manually in ${ide.name}.`)
          })()
        }}
        onCancel={() => onDone('Exited without opening IDE', { display: 'system' })}
      />
    </Dialog>
  )
}

// ── extension install offer ─────────────────────────────────────────────────

function IdeInstallOffer({
  runningIdes,
  context,
  onDone,
}: {
  runningIdes: IdeType[]
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  return (
    <Dialog
      title="Install the Mercury IDE extension"
      onCancel={() => onDone('No IDE selected', { display: 'system' })}
    >
      <Select
        options={runningIdes.map(ide => ({ label: toIDEDisplayName(ide), value: ide }))}
        onChange={value => {
          const ide = value as IdeType
          // Consent is required even for a single candidate: this writes
          // into another application's plugin directory on the strength of a
          // process scan that can misidentify.
          context.onInstallIDEExtension?.(ide)
          // Honest tense: the install runs asynchronously; its result lands
          // in the status surface. Never claim completion.
          const restart = isJetBrainsIde(ide)
            ? ' Restart the IDE fully once it finishes.'
            : ''
          onDone(
            `Installing the ${toIDEDisplayName(ide)} extension — check /status → IDE for the result.${restart}`,
          )
        }}
        onCancel={() => onDone('No IDE selected', { display: 'system' })}
      />
    </Dialog>
  )
}

// ── connect / disconnect flow ───────────────────────────────────────────────

type PendingSelection =
  | { kind: 'connect'; ide: DetectedIDEInfo }
  | { kind: 'disconnect' }

function IdeConnectFlow({
  available,
  unavailable,
  currentIde,
  context,
  onDone,
}: {
  available: DetectedIDEInfo[]
  unavailable: DetectedIDEInfo[]
  currentIde: DetectedIDEInfo | undefined
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [interstitial, setInterstitial] = useState<PendingSelection | null>(null)
  const [connecting, setConnecting] = useState<DetectedIDEInfo | null>(null)
  const firstObservationSkippedRef = useRef(false)
  const settledRef = useRef(false)
  const mcpClients = useAppState(state => state.mcp.clients) as MCPServerConnection[]

  const settle = (message: string, system = false): void => {
    if (settledRef.current) return
    settledRef.current = true
    onDone(message, system ? { display: 'system' } : undefined)
  }

  // The connection watcher. The FIRST observation after dispatch describes
  // the client as it was BEFORE the config change and must not be read as a
  // result.
  useEffect(() => {
    if (!connecting) return
    const client = mcpClients.find(candidate => candidate.name === 'ide')
    if (!firstObservationSkippedRef.current) {
      firstObservationSkippedRef.current = true
      return
    }
    if (client?.type === 'connected') settle(`Connected to ${connecting.name}.`)
    else if (client?.type === 'failed') settle(`Failed to connect to ${connecting.name}.`)
    // pending or absent: keep waiting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpClients, connecting])

  useEffect(() => {
    if (!connecting) return
    const timer = setTimeout(() => {
      settle(`Connection to ${connecting.name} timed out.`)
    }, CONNECT_TIMEOUT_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connecting])

  const applySelection = (selection: PendingSelection): void => {
    if (!context.onChangeDynamicMcpConfig) {
      settle('Error connecting to IDE.')
      return
    }
    // Any selection starts from a copy without the current `ide` entry.
    const config: Record<string, ScopedMcpServerConfig> = {
      ...(context.options.dynamicMcpConfig ?? {}),
    }
    delete config.ide

    if (selection.kind === 'disconnect') {
      const client = mcpClients.find(candidate => candidate.name === 'ide')
      if (currentIde && client && client.type === 'connected') {
        const connected = client as ConnectedMCPServer
        // No auto-reconnect from the close we are about to cause.
        ;(connected.client as { onclose?: (() => void) | undefined }).onclose = undefined
        void clearServerCache('ide', connected.config)
        context.setAppState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: prev.mcp.clients.filter(c => c.name !== 'ide'),
            tools: prev.mcp.tools.filter(tool => !tool.name.startsWith(IDE_TOOL_PREFIX)),
            commands: prev.mcp.commands.filter(
              command => !command.name.startsWith(IDE_TOOL_PREFIX),
            ),
          },
        }))
        context.onChangeDynamicMcpConfig(config)
        settle(`Disconnected from ${currentIde.name}`)
        return
      }
      context.onChangeDynamicMcpConfig(config)
      settle('No IDE selected')
      return
    }

    const ide = selection.ide
    config.ide = {
      // A literal prefix test: `wss:` deliberately takes the sse-ide arm.
      type: ide.url.startsWith('ws:') ? 'ws-ide' : 'sse-ide',
      url: ide.url,
      ideName: ide.name,
      ...(ide.authToken !== undefined ? { authToken: ide.authToken } : {}),
      ...(ide.ideRunningInWindows !== undefined
        ? { ideRunningInWindows: ide.ideRunningInWindows }
        : {}),
      scope: 'dynamic',
    } as ScopedMcpServerConfig
    firstObservationSkippedRef.current = false
    setConnecting(ide)
    context.onChangeDynamicMcpConfig(config)
  }

  const handleChoice = (value: string): void => {
    if (value === 'none') {
      if (shouldShowDisableAutoConnectDialog()) {
        setInterstitial({ kind: 'disconnect' })
        return
      }
      applySelection({ kind: 'disconnect' })
      return
    }
    const ide = available.find(candidate => String(candidate.port) === value)
    if (!ide) {
      settle('No IDE selected')
      return
    }
    if (shouldShowAutoConnectDialog()) {
      setInterstitial({ kind: 'connect', ide })
      return
    }
    applySelection({ kind: 'connect', ide })
  }

  if (interstitial) {
    const proceed = (): void => {
      const selection = interstitial
      setInterstitial(null)
      applySelection(selection)
    }
    return interstitial.kind === 'connect' ? (
      <IdeAutoConnectDialog onComplete={proceed} />
    ) : (
      <IdeDisableAutoConnectDialog onComplete={proceed} />
    )
  }

  if (connecting) {
    return <Text color={tokens.textMuted}>connecting to {connecting.name}…</Text>
  }

  // A workspace-folder description is added only when it disambiguates:
  // more than one instance of the same-named IDE, and folders reported.
  const nameCounts = new Map<string, number>()
  for (const ide of available) {
    nameCounts.set(ide.name, (nameCounts.get(ide.name) ?? 0) + 1)
  }
  const vsCodeWarning = available.some(
    ide => ide.name === 'VS Code' || ide.name === 'Visual Studio Code',
  )

  return (
    <Dialog
      title="Select IDE"
      subtitle="Connect an IDE for integrated development features"
      onCancel={() => settle('IDE selection cancelled', true)}
    >
      <Box flexDirection="column" gap={1}>
        {available.length === 0 ? (
          <Text color={tokens.textMuted}>
            To connect, the Mercury editor extension/plugin must be installed and the editor must
            be running.
          </Text>
        ) : (
          <Select
            options={[
              ...available.map(ide => ({
                label: ide.name,
                value: String(ide.port),
                ...((nameCounts.get(ide.name) ?? 0) > 1 && ide.workspaceFolders.length > 0
                  ? { description: formatWorkspaceFolders(ide.workspaceFolders) }
                  : {}),
              })),
              { label: 'None', value: 'none' },
            ]}
            defaultValue={currentIde ? String(currentIde.port) : 'none'}
            onChange={handleChoice}
            onCancel={() => settle('IDE selection cancelled', true)}
          />
        )}
        {vsCodeWarning ? (
          <Text color={tokens.warning}>Only one instance can be connected to VS Code at a time.</Text>
        ) : null}
        {!isSupportedTerminal() ? (
          <Text color={tokens.textMuted}>
            Tip: auto-connect at launch with the --ide flag, or set it in /config.
          </Text>
        ) : null}
        {unavailable.length > 0 ? (
          <Box flexDirection="column">
            <Text color={tokens.textMuted}>
              {unavailable.length} other running IDE{unavailable.length === 1 ? '' : 's'} found
              whose workspace/project directories do not match the current working directory:
            </Text>
            {unavailable.map(ide => (
              <Text key={`${ide.name}-${ide.port}`} color={tokens.textMuted}>
                {'  '}· {ide.name} — {formatWorkspaceFolders(ide.workspaceFolders)}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    </Dialog>
  )
}

// ── the command ─────────────────────────────────────────────────────────────

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  if (args.trim().toLowerCase() === 'open') {
    const worktree = getCurrentWorktreeSession()
    const targetPath = worktree ? worktree.worktreePath : getCwd()
    const valid = (await detectIDEs(true)).filter(ide => ide.isValid)
    if (valid.length === 0) {
      onDone('No IDEs with the Mercury extension detected.')
      return null
    }
    return (
      <IdeOpenPicker
        ides={valid}
        targetPath={targetPath}
        targetKind={worktree ? 'worktree' : 'project'}
        onDone={onDone}
      />
    )
  }

  let detected = await detectIDEs(true)
  if (detected.length === 0 && context.onInstallIDEExtension && !isSupportedTerminal()) {
    const running = await detectRunningIDEs()
    if (running.length > 0) {
      return <IdeInstallOffer runningIdes={running} context={context} onDone={onDone} />
    }
    detected = []
  }

  const available = detected.filter(ide => ide.isValid)
  const unavailable = detected.filter(ide => !ide.isValid)
  const ideEntry = context.options.dynamicMcpConfig?.ide
  const currentIde =
    ideEntry && (ideEntry.type === 'ws-ide' || ideEntry.type === 'sse-ide')
      ? available.find(ide => ide.url === ideEntry.url)
      : undefined

  return (
    <IdeConnectFlow
      available={available}
      unavailable={unavailable}
      currentIde={currentIde}
      context={context}
      onDone={onDone}
    />
  )
}
