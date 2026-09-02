// The searchable settings list: a flat item catalogue (conditional
// on capability and environment), per-item persistence targets, the change
// map behind the save summary, search-first navigation, sub-menus that hide
// the tab row, and the revert-on-escape law — every toggle persists
// immediately, so cancel re-persists the mount-time snapshots (theme first,
// then the global config monolith, then each touched local/user key, then
// the app-state fields).

import figures from 'figures'
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { enqueueNotification } from '../../context/notifications.js'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  getGlobalConfig,
  saveGlobalConfig,
  getAutoUpdaterDisabledReason,
  formatAutoUpdaterDisabledReason,
  getCustomApiKeyStatus,
  isAutoUpdaterDisabled,
  type GlobalConfig,
  type NotificationChannel,
} from '../../utils/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
  getInitialSettings,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import {
  clearInstructionFileCaches,
} from '../../services/instructions/engine.js'
import {
  setSessionInstructionProfile,
  isInstructionProfile,
} from '../../services/instructions/profile.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { isFullscreenActive } from '../../utils/fullscreen.js'
import { stripFacts } from '../../context/surfaceRoute.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  EXTERNAL_PERMISSION_MODES,
  permissionModeTitle,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import { getMainLoopModel, modelDisplayString } from '../../utils/model/model.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import {
  providerFamilyPresences,
  type ProviderFamilyPresence,
} from '../../services/providers/providerUsage.js'
import { REACHABLE_THEME_SETTINGS } from '../../utils/theme.js'
import { useTheme, useThemeSetting } from '../design-system/ThemeProvider.js'
import { useTabHeaderFocus, useTabsWidth } from '../design-system/Tabs.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { SearchBox } from '../SearchBox.js'
import { Select } from '../CustomSelect/select.js'
import { LanguagePicker } from '../LanguagePicker.js'
import { ChannelDowngradeDialog } from '../ChannelDowngradeDialog.js'
import { ExternalInstructionIncludesDialog } from '../ExternalInstructionIncludesDialog.js'
import type { ExternalInstructionInclude } from '../../services/instructions/engine.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { clearCliTeammateModeOverride } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'

/** Fixed label column width. */
const LABEL_CELLS = 44

function currentAppVersion(): string {
  return typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
}

type SubMenu =
  | 'theme'
  | 'teammate-model'
  | 'external-includes'
  | 'language'
  | 'channel-downgrade'
  | 'auto-updates-info'

/** 'info' rows are read-only facts (no change, no sub-menu) — they point at
 *  the surface that owns the setting instead of re-implementing it. */
type ItemKind = 'boolean' | 'enum' | 'managed-enum' | 'info'

type SettingsItem = {
  id: string
  label: string
  /** Plain search text when the visible label is rich. */
  searchText?: string
  kind: ItemKind
  value: React.ReactNode
  /** Toggle / cycle in the given direction. */
  change?: (direction: 1 | -1) => void
  /** Open the managed sub-menu. */
  open?: SubMenu
  /** Extra text below the row while selected (the thinking warning). */
  warning?: string
}

/** Human labels for notification channels, naming the underlying terminal
 *  escape mechanism where one exists. */
const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  auto: 'auto (pick per terminal)',
  iterm2: 'iTerm2 (OSC 9)',
  iterm2_with_bell: 'iTerm2 (OSC 9) + bell (BEL)',
  terminal_bell: 'terminal bell (BEL)',
  kitty: 'kitty (OSC 99)',
  ghostty: 'Ghostty (OSC 777)',
  notifications_disabled: 'disabled',
}

const THEME_LABELS: Record<string, string> = {
  auto: 'auto (match terminal)',
  dark: 'Dark',
  'true-black': 'True Black',
  light: 'Light',
  'dark-daltonized': 'Dark (colourblind-friendly)',
  'light-daltonized': 'Light (colourblind-friendly)',
  'dark-ansi': 'Dark (ANSI only)',
  'light-ansi': 'Light (ANSI only)',
}

// ── provider-derived rows ─────────────────────────────────────
//  /config's provider/model/account rows DERIVE from the provider families
//  the router catalogue knows (providerFamilyPresences — the one shared
//  enumeration): zero hardcoded provider pairs, so a future adapter appears
//  here with no edit. Rows are read-only POINTERS — /model owns model
//  selection and /accounts (·/logins·/router key) owns accounts; this list
//  never re-implements another command's surface.

/** Presentation facts per KNOWN provider id (display casing + the product's
 *  routes). An unknown id still gets a row, labeled by the id. */
const CONFIG_PROVIDER_PRESENTATION: Record<
  string,
  { label: string; absent: string; manage?: string }
> = {
  anthropic: { label: 'Anthropic', absent: 'not signed in — /logins connects', manage: '/accounts' },
  openai: { label: 'OpenAI', absent: 'not signed in — /logins connects', manage: '/accounts' },
  zai: { label: 'Z.AI', absent: 'no key — /logins zai connects (or ZAI_API_KEY)', manage: '/accounts' },
  openrouter: { label: 'OpenRouter', absent: 'not signed in — /logins connects', manage: '/accounts' },
  gemini: { label: 'Gemini', absent: 'not signed in — /logins connects', manage: '/accounts' },
  moonshot: { label: 'Moonshot', absent: 'not signed in — /logins moonshot connects (or MOONSHOT_API_KEY)', manage: '/accounts' },
  deepseek: { label: 'DeepSeek', absent: 'no key — /logins deepseek connects (or DEEPSEEK_API_KEY)', manage: '/accounts' },
  'openai-compat': { label: 'Custom endpoint', absent: 'not configured — MERCURY_COMPAT_BASE_URL' },
  huggingface: { label: 'Hugging Face', absent: 'not signed in — /logins connects (or HF_TOKEN)', manage: '/accounts' },
  local: { label: 'Local', absent: 'no sign-in — start a local server or MERCURY_LOCAL_BASE_URL' },
}

// ── cross-provider row applicability ─────────
//  A Config row that only drives ONE provider's lane must say so and refuse
//  changes while another provider serves the session — a toggle that writes
//  a setting the active lane never reads is a silently broken control (the
//  audit found two: Thinking mode configures the Anthropic wire, and the
//  custom-API-key approval governs the ANTHROPIC_API_KEY
//  credential; the GPT lane accepts-but-ignores ThinkingConfig and the Z.AI
//  lane never reads it). PURE decision here; the component wraps rows with
//  it so provers pin the law without a render.

export function configRowApplicability(
  appliesTo: 'anthropic',
  route: string,
): { applies: true } | { applies: false; naText: string; refuseNote: string } {
  if (route === appliesTo) return { applies: true }
  const laneLabel = CONFIG_PROVIDER_PRESENTATION[appliesTo]?.label ?? appliesTo
  const activeLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
  return {
    applies: false,
    naText: `n/a — applies to ${laneLabel} models (${activeLabel} is active)`,
    refuseNote: `This setting only affects the ${laneLabel} lane; the session runs on ${activeLabel} — /model switches provider.`,
  }
}

/** The main-loop pointer row's text: active provider + model, from the
 *  owning resolvers (the routing law + the model display owner). */
export function mainLoopPointerText(
  effective: string | null,
  reads?: { resolvedModel?: () => string; routeOf?: (model: string) => string },
): string {
  const resolved = reads?.resolvedModel?.() ?? getMainLoopModel()
  const model = effective ?? resolved
  const route = reads?.routeOf?.(model) ?? declaredRouteOf(model) ?? 'unrecognised'
  const providerLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
  const modelText =
    effective !== null ? modelDisplayString(effective) : `default (${modelDisplayString(resolved)})`
  return `${providerLabel} · ${modelText} — /model`
}

export interface ConfigProviderRow {
  id: string
  label: string
  valueText: string
  credentialed: boolean
}

/** Pure: families → the account-presence rows (the derivation-law prover
 *  feeds a fabricated third family and gets a third row with no UI edit). */
export function configProviderRows(families: ProviderFamilyPresence[]): ConfigProviderRow[] {
  return families
    .map(family => {
      const meta = CONFIG_PROVIDER_PRESENTATION[family.id] ?? {
        label: family.id,
        absent: 'not connected — see /capabilities',
      }
      return {
        id: `account-${family.id}`,
        label: `${meta.label} account`,
        valueText: family.credentialed
          ? `${family.credentialLabel}${meta.manage ? ` — ${meta.manage}` : ''}`
          : meta.absent,
        credentialed: family.credentialed,
      }
    })
}

function cycleIn<T>(list: readonly T[], current: T, direction: 1 | -1): T {
  const at = list.indexOf(current)
  const base = at < 0 ? 0 : at
  return list[(base + direction + list.length) % list.length] as T
}

/** Validate a closed-vocabulary enum value; unknown input falls back to the
 *  default member. */
function validated<T extends string>(
  list: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

export function Config({
  onClose,
  context,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
}: {
  onClose: (result?: unknown) => void
  context: LocalJSXCommandContext
  setTabsHidden: (hidden: boolean) => void
  onIsSearchModeChange?: (ownsEscape: boolean) => void
  contentHeight?: number
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const setAppState = useSetAppState()
  const appState = useAppState((s: AppState) => s)
  const [themeName, setThemeSetting] = useTheme()
  const themeSetting = useThemeSetting()
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const tabsWidth = useTabsWidth()

  // Re-read live config/settings each render (writes below bump version).
  const [version, setVersion] = useState(0)
  const bump = (): void => setVersion(v => v + 1)
  void version
  const config = getGlobalConfig()
  const merged = getInitialSettings() as SettingsJson

  // ── mount-time snapshots (the revert inputs) ─────────────────────────────
  const snapshotsRef = useRef<{
    global: GlobalConfig
    theme: string
    local: Partial<SettingsJson>
    user: Partial<SettingsJson>
    appVerbose: boolean
    dirty: boolean
  } | null>(null)
  if (snapshotsRef.current === null) {
    const local = getSettingsForSource('localSettings') ?? {}
    const user = getSettingsForSource('userSettings') ?? {}
    snapshotsRef.current = {
      global: JSON.parse(JSON.stringify(getGlobalConfig())) as GlobalConfig,
      theme: themeSetting,
      local: {
        spinnerTipsEnabled: local.spinnerTipsEnabled,
        prefersReducedMotion: local.prefersReducedMotion,
        instructionProfile: local.instructionProfile,
      },
      user: {
        alwaysThinkingEnabled: user.alwaysThinkingEnabled,
        promptSuggestionEnabled: user.promptSuggestionEnabled,
        autoUpdatesChannel: user.autoUpdatesChannel,
        minimumVersion: user.minimumVersion,
        language: user.language,
        syntaxHighlightingDisabled: user.syntaxHighlightingDisabled,
        permissions: user.permissions,
      },
      appVerbose: appState.verbose === true,
      dirty: false,
    }
  }
  const snapshots = snapshotsRef.current

  // ── the change map (the save summary's source) ───────────────────────────
  const changesRef = useRef(new Map<string, string>())
  /** Boolean toggle-off rule: an existing key is removed, so flipping back
   *  to the start leaves no entry. */
  const recordToggle = (key: string, text: string): void => {
    snapshots.dirty = true
    if (changesRef.current.has(key)) changesRef.current.delete(key)
    else changesRef.current.set(key, text)
  }
  const recordSet = (key: string, text: string): void => {
    snapshots.dirty = true
    changesRef.current.delete(key)
    changesRef.current.set(key, text)
  }

  // ── persistence helpers ──────────────────────────────────────────────────
  const writeSource = (
    source: 'localSettings' | 'userSettings',
    partial: Partial<SettingsJson>,
  ): boolean => {
    const { error } = updateSettingsForSource(source, partial)
    if (error !== null) {
      logForDebugging(`settings write failed (${source}): ${error.message}`)
      // C7 disclosure: a failed toggle write painted NOTHING — the row
      // silently snapped back. One line on the real notification channel
      // (the composer stays mounted under this dialog, so it paints live).
      enqueueNotification(setAppState, {
        key: 'config-write-failed',
        text: `that change did not save — ${source === 'localSettings' ? 'project-local' : 'user'} settings write failed: ${error.message}`,
        priority: 'high',
        color: 'error',
        timeoutMs: 15_000,
      })
      return false
    }
    return true
  }
  /** Top-level global-config keys THIS dialog wrote — the revert's exact
   *  undo set. Tracked by diffing the mutate against the read view (the
   *  locked write still re-reads fresh; this diff only records identity). */
  const globalTouchedRef = useRef(new Set<string>())
  const writeGlobal = (mutate: (config: GlobalConfig) => GlobalConfig): void => {
    const before = getGlobalConfig()
    const after = mutate(before)
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.is((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key])) {
        globalTouchedRef.current.add(key)
      }
    }
    saveGlobalConfig(mutate)
    snapshots.dirty = true
    bump()
  }

  // ── sub-menu + warning state ─────────────────────────────────────────────
  const [subMenu, setSubMenu] = useState<SubMenu | null>(null)
  useEffect(() => {
    setTabsHidden(subMenu !== null)
  }, [subMenu, setTabsHidden])
  const [thinkingWarning, setThinkingWarning] = useState(false)

  // ── the item catalogue ───────────────────────────────────────────────────
  const conversationHasAssistantTurn = context.messages.some(
    message => message.type === 'assistant',
  )
  const ideConnected =
    appState.mcp.clients.some(
      client =>
        (client as { name?: string; type?: string }).name === 'ide' &&
        (client as { connected?: boolean; type?: string }).type === 'connected',
    )
  const thinkingOn = merged.alwaysThinkingEnabled === true
  const permissions = merged.permissions ?? {}
  const defaultMode = validated(
    EXTERNAL_PERMISSION_MODES,
    permissions.defaultMode,
    'default',
  )
  // Default and strategy first, then the remaining external modes; sovereign excluded.
  const modeOptions: readonly ExternalPermissionMode[] = [
    'default',
    'strategy',
    ...EXTERNAL_PERMISSION_MODES.filter(
      mode => mode !== 'default' && mode !== 'strategy' && mode !== 'sovereign',
    ),
  ]

  const boolValue = (on: boolean): React.ReactNode => (
    <Text color={on ? tokens.success : tokens.textSecondary}>
      {on ? 'on' : 'off'}
    </Text>
  )

  // The main loop's provider (the routing law over the effective model) —
  // the provider-scoped rows key their applicability on it.
  const mainRoute = declaredRouteOf(
    appState.mainLoopModelForSession ?? appState.mainLoopModel ?? getMainLoopModel(),
  )
  /** Wrap a provider-scoped row: outside its lane the value is the quiet
   *  honest n/a, the selected-row note names the owning lane, and the
   *  change handler refuses (no write, no recorded change). */
  const providerScoped = (item: SettingsItem, appliesTo: 'anthropic'): SettingsItem => {
    const applicability = configRowApplicability(appliesTo, mainRoute ?? 'unrecognised')
    if (applicability.applies) return item
    return {
      ...item,
      value: <Text color={tokens.textSecondary}>{applicability.naText}</Text>,
      warning: applicability.refuseNote,
      change: () => {},
    }
  }

  const items: SettingsItem[] = []

  items.push({
    id: 'autoCompact',
    label: 'Auto-compact',
    kind: 'boolean',
    value: boolValue(config.autoCompactEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, autoCompactEnabled: c.autoCompactEnabled === false }))
      recordToggle('autoCompact', `set auto-compact to ${config.autoCompactEnabled === false ? 'on' : 'off'}`)
    },
  })
  // THE WORLD, HONESTLY (the chat-mode law): the row's value is the saved
  // switch; a `--chat` boot is the plain world whatever the switch says, so
  // the row says so beside it — the switch it toggles governs the next
  // plain `mercury` boot, never this one.
  const world = stripFacts()
  items.push({
    // THE CONCOURSE SWITCH: the
    // /config writer of the persisted field, symmetric with the boot's
    // --concourse-off / --concourse-on (default on; never heal-repainted).
    id: 'concourse',
    label: 'Session concourse',
    searchText: 'session concourse coordinator live view concourse-off chat plain world',
    kind: 'boolean',
    value: world.chatBoot ? (
      <Text>
        {boolValue(config.concourseEnabled !== false)}
        <Text color={tokens.textSecondary}> · off this boot (--chat)</Text>
      </Text>
    ) : (
      boolValue(config.concourseEnabled !== false)
    ),
    ...(world.chatBoot
      ? { warning: 'this boot is --chat: the plain world whatever the switch says — the switch governs the next plain `mercury` boot' }
      : {}),
    change: () => {
      const next = config.concourseEnabled === false
      writeGlobal(c => ({ ...c, concourseEnabled: next }))
      recordToggle('concourse', `set the session concourse to ${next ? 'on' : 'off (live view only)'}`)
    },
  })
  items.push({
    id: 'tips',
    label: 'Tips',
    kind: 'boolean',
    value: boolValue(merged.spinnerTipsEnabled !== false),
    change: () => {
      const next = merged.spinnerTipsEnabled === false
      if (writeSource('localSettings', { spinnerTipsEnabled: next ? undefined : false })) {
        snapshots.dirty = true
        recordToggle('tips', `set tips to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'reducedMotion',
    label: 'Reduced motion',
    kind: 'boolean',
    value: boolValue(merged.prefersReducedMotion === true),
    change: () => {
      const next = merged.prefersReducedMotion !== true
      if (writeSource('localSettings', { prefersReducedMotion: next ? true : undefined })) {
        snapshots.dirty = true
        recordToggle('reducedMotion', `set reduced motion to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'instructionProfile',
    label: 'Instruction profile',
    kind: 'enum',
    value: <Text>{merged.instructionProfile ?? 'auto'}</Text>,
    change: direction => {
      const profiles = ['auto', 'native'] as const
      const current = validated(profiles, merged.instructionProfile, 'auto')
      const next = cycleIn(profiles, current, direction)
      // LOCAL settings on purpose: the local layer outranks a profile
      // committed in the project's settings, so the operator's explicit
      // choice survives a restart. Then apply live.
      if (writeSource('localSettings', { instructionProfile: next })) {
        snapshots.dirty = true
        setSessionInstructionProfile(next === 'auto' ? null : isInstructionProfile(next) ? next : null)
        clearInstructionFileCaches()
        recordSet('instructionProfile', `set instruction profile to ${next}`)
        bump()
      }
    },
  })
  items.push(providerScoped({
    id: 'thinking',
    label: 'Thinking mode',
    kind: 'boolean',
    value: boolValue(thinkingOn),
    warning:
      thinkingWarning && conversationHasAssistantTurn
        ? 'Thinking raises latency and can reduce quality mid-conversation.'
        : undefined,
    change: () => {
      const next = !thinkingOn
      // Off persists an explicit false; on is a deletion so the merged
      // default wins when unset.
      if (writeSource('userSettings', { alwaysThinkingEnabled: next ? undefined : false })) {
        snapshots.dirty = true
        recordToggle('thinking', `set thinking mode to ${next ? 'on' : 'off'}`)
        if (conversationHasAssistantTurn) {
          const initial = snapshots.user.alwaysThinkingEnabled === true
          setThinkingWarning(next !== initial)
        }
        bump()
      }
    },
  }, 'anthropic'))
  items.push({
    id: 'verbose',
    label: 'Verbose output',
    kind: 'boolean',
    value: boolValue(appState.verbose === true),
    change: () => {
      snapshots.dirty = true
      setAppState(prev => ({ ...prev, verbose: prev.verbose !== true }))
      recordToggle('verbose', `set verbose output to ${appState.verbose === true ? 'off' : 'on'}`)
    },
  })
  items.push({
    id: 'terminalProgressBar',
    label: 'Terminal progress bar',
    kind: 'boolean',
    value: boolValue(config.terminalProgressBarEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, terminalProgressBarEnabled: c.terminalProgressBarEnabled === false }))
      recordToggle('terminalProgressBar', `set terminal progress bar to ${config.terminalProgressBarEnabled === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'turnDuration',
    label: 'Turn duration',
    kind: 'boolean',
    value: boolValue(config.showTurnDuration !== false),
    change: () => {
      writeGlobal(c => ({ ...c, showTurnDuration: c.showTurnDuration === false }))
      recordToggle('turnDuration', `set turn duration to ${config.showTurnDuration === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'defaultPermissionMode',
    label: 'Default permission mode',
    kind: 'enum',
    value: <Text>{permissionModeTitle(defaultMode)}</Text>,
    change: direction => {
      const next = cycleIn(modeOptions, defaultMode, direction)
      if (
        writeSource('userSettings', {
          // ONLY the changed key: the writer's merge is recursive, so this
          // touches defaultMode alone. Spreading the MERGED view here wrote
          // the PROJECT's allow/deny/additionalDirectories into the
          // user-global file — a silent scope corruption every mode toggle
          // repeated (prove-settings-write-scope).
          permissions: { defaultMode: next },
        })
      ) {
        snapshots.dirty = true
        recordSet('defaultPermissionMode', `set default permission mode to ${permissionModeTitle(next)}`)
        bump()
      }
    },
  })
  items.push({
    id: 'respectGitignore',
    label: 'Respect .gitignore in file picker',
    kind: 'boolean',
    value: boolValue(config.respectGitignore !== false),
    change: () => {
      writeGlobal(c => ({ ...c, respectGitignore: c.respectGitignore === false }))
      recordToggle('respectGitignore', `set respect-gitignore to ${config.respectGitignore === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'copyFullResponse',
    label: 'Always copy full response',
    kind: 'boolean',
    value: boolValue(config.copyFullResponse === true),
    change: () => {
      writeGlobal(c => ({ ...c, copyFullResponse: c.copyFullResponse !== true }))
      recordToggle('copyFullResponse', `set always-copy-full-response to ${config.copyFullResponse !== true ? 'on' : 'off'}`)
    },
  })

  // Auto-update channel — special: disabled shows the formatted reason and
  // opens the explanatory sub-menu; latest opens the downgrade dialog;
  // stable switches straight to latest, clearing any minimum-version pin.
  const updatesDisabled = isAutoUpdaterDisabled()
  const channel = validated(['latest', 'stable'] as const, merged.autoUpdatesChannel, 'latest')
  items.push({
    id: 'autoUpdateChannel',
    label: 'Auto-update channel',
    kind: 'managed-enum',
    value: updatesDisabled ? (
      <Text color={tokens.textSecondary}>
        disabled · {(() => {
          const reason = getAutoUpdaterDisabledReason()
          return reason !== null ? formatAutoUpdaterDisabledReason(reason) : 'unknown reason'
        })()}
      </Text>
    ) : (
      <Text>{channel}</Text>
    ),
    open: updatesDisabled
      ? 'auto-updates-info'
      : channel === 'latest'
        ? 'channel-downgrade'
        : undefined,
    change: !updatesDisabled && channel === 'stable'
      ? () => {
          if (
            writeSource('userSettings', {
              autoUpdatesChannel: 'latest',
              minimumVersion: undefined,
            })
          ) {
            snapshots.dirty = true
            recordSet('autoUpdateChannel', 'set auto-update channel to latest')
            bump()
          }
        }
      : undefined,
  })
  items.push({
    id: 'theme',
    label: 'Theme',
    kind: 'managed-enum',
    value: <Text>{THEME_LABELS[themeSetting] ?? themeSetting}</Text>,
    open: 'theme',
  })
  items.push({
    id: 'notifChannel',
    label: 'Notifications channel',
    kind: 'enum',
    value: (
      <Text>
        {CHANNEL_LABELS[
          validated([...NOTIFICATION_CHANNELS], config.preferredNotifChannel, 'auto')
        ]}
      </Text>
    ),
    change: direction => {
      const current = validated([...NOTIFICATION_CHANNELS], config.preferredNotifChannel, 'auto')
      const next = cycleIn({ options: [...NOTIFICATION_CHANNELS] }.options, current, direction)
      writeGlobal(c => ({ ...c, preferredNotifChannel: next }))
      recordSet('notifChannel', `set notifications channel to ${next}`)
    },
  })
  items.push({
    id: 'pingsBell',
    label: 'Pings bell',
    kind: 'boolean',
    value: boolValue(config.pingsBell !== false),
    change: () => {
      const next = config.pingsBell === false
      writeGlobal(c => ({ ...c, pingsBell: next }))
      recordToggle('pingsBell', `set pings bell to ${next ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'language',
    label: 'Language',
    kind: 'managed-enum',
    value: <Text>{merged.language ?? 'auto'}</Text>,
    open: 'language',
  })
  items.push({
    id: 'editorMode',
    label: 'Editor mode',
    kind: 'enum',
    value: <Text>{validated(EDITOR_MODES, config.editorMode, 'normal')}</Text>,
    change: direction => {
      const current = validated(EDITOR_MODES, config.editorMode, 'normal')
      const next = cycleIn(EDITOR_MODES, current, direction)
      writeGlobal(c => ({ ...c, editorMode: next }))
      recordSet('editorMode', `set editor mode to ${next}`)
    },
  })
  items.push({
    id: 'prStatusFooter',
    label: 'PR status footer',
    kind: 'boolean',
    value: boolValue(config.prStatusFooterEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, prStatusFooterEnabled: c.prStatusFooterEnabled === false }))
      recordToggle('prStatusFooter', `set PR status footer to ${config.prStatusFooterEnabled === false ? 'on' : 'off'}`)
    },
  })
  // ── provider-derived pointer rows ─────────────────────────
  // The main loop's active provider + model — /model OWNS selection (the one
  // boundary-aware transition machine); this row only points there. The old
  // sub-menu re-implemented the switch through a second picker, bypassing
  // that machine.
  items.push({
    id: 'model',
    label: 'Model (main loop)',
    searchText: 'model provider main loop',
    kind: 'info',
    value: (
      <Text>
        {mainLoopPointerText(appState.mainLoopModelForSession ?? appState.mainLoopModel)}
      </Text>
    ),
  })
  // One account-presence row per provider family the catalogue knows —
  // each answered by its owning resolver, pointing at the surface that
  // manages it.
  for (const row of configProviderRows(providerFamilyPresences())) {
    items.push({
      id: row.id,
      label: row.label,
      searchText: `${row.label} provider signed in`,
      kind: 'info',
      // The value cell truncates beside its fixed label column: at the
      // minimum width the moonshot/deepseek/local lines used to wrap the
      // env-var tail onto a second row under an empty label.
      value: (
        <Text color={row.credentialed ? tokens.success : tokens.textSecondary} wrap="truncate-end">
          {row.valueText}
        </Text>
      ),
    })
  }

  // ── conditional items ────────────────────────────────────────────────────
  if (getFeatureValue_CACHED_MAY_BE_STALE<boolean>('mercury_chomp_inflection', false) === true) {
    const on = merged.promptSuggestionEnabled !== false
    items.push({
      id: 'promptSuggestions',
      label: 'Prompt suggestions',
      kind: 'boolean',
      value: boolValue(on),
      change: () => {
        const next = !on
        if (writeSource('userSettings', { promptSuggestionEnabled: next ? undefined : false })) {
          snapshots.dirty = true
          recordToggle('promptSuggestions', `set prompt suggestions to ${next ? 'on' : 'off'}`)
          bump()
        }
      },
    })
  }
  {
    items.push({
      id: 'fileCheckpointing',
      label: 'File checkpointing',
      kind: 'boolean',
      value: boolValue(config.fileCheckpointingEnabled !== false),
      change: () => {
        writeGlobal(c => ({ ...c, fileCheckpointingEnabled: c.fileCheckpointingEnabled === false }))
        recordToggle('fileCheckpointing', `set file checkpointing to ${config.fileCheckpointingEnabled === false ? 'on' : 'off'}`)
      },
    })
    // The switch above is the operator's intent; this row is what THIS
    // session's runner actually does (FN-015 rank 8: the process that runs
    // the tools captured nothing while the switch read on). Read from the
    // runner's own facts through the focused connector.
    const facts = getFocusedSessionConnector().checkpointFacts()
    const points = facts.restorable.size
    const sessionText = !hasFocusedSession()
      ? 'no chat open'
      : facts.capture === 'on'
        ? `capturing · ${points} restore point${points === 1 ? '' : 's'}`
        : facts.capture === 'off'
          ? 'not capturing in this session'
          : "not reported — this session's runner predates checkpoint capture (/daemon restart when ready)"
    items.push({
      id: 'fileCheckpointsSession',
      label: 'Checkpoints in this session',
      searchText: 'checkpoints session rewind restore points capture',
      kind: 'info',
      value: <Text color={facts.capture === 'on' ? tokens.success : tokens.textSecondary}>{sessionText}</Text>,
    })
  }
  if (getFeatureValue_CACHED_MAY_BE_STALE<boolean>('terminal_tab_status', false) === true) {
    items.push({
      id: 'terminalTabStatus',
      label: 'Terminal-tab status',
      kind: 'boolean',
      value: boolValue(config.showStatusInTerminalTab === true),
      change: () => {
        writeGlobal(c => ({ ...c, showStatusInTerminalTab: c.showStatusInTerminalTab !== true }))
        recordToggle('terminalTabStatus', `set terminal-tab status to ${config.showStatusInTerminalTab !== true ? 'on' : 'off'}`)
      },
    })
  }
  if (isFullscreenActive()) {
    items.push({
      id: 'copyOnSelect',
      label: 'Copy on select',
      kind: 'boolean',
      value: boolValue(config.copyOnSelect !== false),
      change: () => {
        writeGlobal(c => ({ ...c, copyOnSelect: c.copyOnSelect === false }))
        recordToggle('copyOnSelect', `set copy-on-select to ${config.copyOnSelect === false ? 'on' : 'off'}`)
      },
    })
  }
  if (ideConnected) {
    items.push({
      id: 'diffTool',
      label: 'Diff tool',
      kind: 'enum',
      value: <Text>{config.diffTool ?? 'auto'}</Text>,
      change: direction => {
        const tools = ['auto', 'terminal'] as const
        const current = validated(tools, config.diffTool, 'auto')
        const next = cycleIn(tools, current, direction)
        writeGlobal(c => ({ ...c, diffTool: next }))
        recordSet('diffTool', `set diff tool to ${next}`)
      },
    })
  }
  if (context.options.ideInstallationStatus === null) {
    items.push({
      id: 'autoConnectIde',
      label: 'Auto-connect to IDE',
      kind: 'boolean',
      value: boolValue(config.autoConnectIde === true),
      change: () => {
        writeGlobal(c => ({ ...c, autoConnectIde: c.autoConnectIde !== true }))
        recordToggle('autoConnectIde', `set auto-connect IDE to ${config.autoConnectIde !== true ? 'on' : 'off'}`)
      },
    })
  } else {
    items.push({
      id: 'autoInstallIdeExtension',
      label: 'Auto-install IDE extension',
      kind: 'boolean',
      value: boolValue(config.autoInstallIdeExtension !== false),
      change: () => {
        writeGlobal(c => ({ ...c, autoInstallIdeExtension: c.autoInstallIdeExtension === false }))
        recordToggle('autoInstallIdeExtension', `set auto-install IDE extension to ${config.autoInstallIdeExtension === false ? 'on' : 'off'}`)
      },
    })
  }
  if (isAgentSwarmsEnabled()) {
    // teammateMode is a GLOBAL CONFIG key (the snapshot reader consults
    // getGlobalConfig); a UI change also clears the CLI override so it
    // takes effect this session.
    const teammateModes = ['auto', 'tmux', 'in-process'] as const
    const teammateMode = validated(teammateModes, config.teammateMode, 'auto')
    items.push({
      id: 'teammateMode',
      label: 'Teammate mode',
      kind: 'enum',
      value: <Text>{teammateMode}</Text>,
      change: direction => {
        const next = cycleIn(teammateModes, teammateMode, direction)
        clearCliTeammateModeOverride(next)
        writeGlobal(c => ({ ...c, teammateMode: next }))
        recordSet('teammateMode', `set teammate mode to ${next}`)
      },
    })
    items.push({
      id: 'defaultTeammateModel',
      label: 'Default teammate model',
      kind: 'managed-enum',
      value: (
        <Text>
          {(() => {
            const value = config.teammateDefaultModel
            if (value === undefined) return 'default'
            if (value === null) return "leader's model"
            return modelDisplayString(value)
          })()}
        </Text>
      ),
      open: 'teammate-model',
    })
  }
  const externalIncludes = (
    appState as { externalIncludes?: ExternalInstructionInclude[] }
  ).externalIncludes
  if (Array.isArray(externalIncludes) && externalIncludes.length > 0) {
    items.push({
      id: 'externalIncludes',
      label: 'External-includes approval',
      kind: 'managed-enum',
      value: <Text>review</Text>,
      open: 'external-includes',
    })
  }
  if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY !== '') {
    const status = getCustomApiKeyStatus(process.env.ANTHROPIC_API_KEY)
    items.push(providerScoped({
      id: 'customApiKey',
      label: 'Use custom API key',
      kind: 'boolean',
      value: boolValue(status === 'approved'),
      change: () => {
        const key = process.env.ANTHROPIC_API_KEY as string
        const truncated = key.slice(-20)
        writeGlobal(c => {
          const approved = new Set(c.customApiKeyResponses?.approved ?? [])
          const rejected = new Set(c.customApiKeyResponses?.rejected ?? [])
          if (status === 'approved') {
            approved.delete(truncated)
            rejected.add(truncated)
          } else {
            rejected.delete(truncated)
            approved.add(truncated)
          }
          return {
            ...c,
            customApiKeyResponses: {
              approved: [...approved],
              rejected: [...rejected],
            },
          }
        })
        recordToggle('customApiKey', `set custom API key to ${status === 'approved' ? 'off' : 'on'}`)
      },
    }, 'anthropic'))
  }

  // ── search + selection state ─────────────────────────────────────────────
  const [searchMode, setSearchMode] = useState(true)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [offset, setOffset] = useState(0)

  const filtered = useMemo(() => {
    if (query === '') return items
    const needle = query.toLowerCase()
    return items.filter(
      item =>
        item.id.toLowerCase().includes(needle) ||
        item.label.toLowerCase().includes(needle) ||
        (item.searchText ?? '').toLowerCase().includes(needle),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- items rebuilt every render; the query is the real input
  }, [query, version, appState, themeSetting])

  const paneHeight = contentHeight ?? 20
  const windowSize = Math.max(5, paneHeight - 10)

  // Synchronous offset-following (an effect-only adjustment leaves a frame
  // with the selection off-window); also reconciled on shrink/resize.
  const reconcile = useCallback(
    (nextSelected: number, list: number): { sel: number; off: number } => {
      const sel = Math.max(0, Math.min(nextSelected, list - 1))
      let off = offset
      if (sel < off) off = sel
      if (sel >= off + windowSize) off = sel - windowSize + 1
      off = Math.max(0, Math.min(off, Math.max(0, list - windowSize)))
      return { sel, off }
    },
    [offset, windowSize],
  )
  useEffect(() => {
    const fixed = reconcile(selected, filtered.length)
    if (fixed.sel !== selected) setSelected(fixed.sel)
    if (fixed.off !== offset) setOffset(fixed.off)
  }, [filtered.length, reconcile, selected, offset])

  const moveTo = (next: number): void => {
    const fixed = reconcile(next, filtered.length)
    setSelected(fixed.sel)
    setOffset(fixed.off)
    setThinkingWarning(false)
  }

  // Escape ownership: this tab owns escape only while search mode has the
  // keyboard and the tab header is not focused.
  const ownsEscape = searchMode && !headerFocused
  useEffect(() => {
    onIsSearchModeChange?.(ownsEscape)
  }, [ownsEscape, onIsSearchModeChange])

  // ── save + revert ────────────────────────────────────────────────────────
  const composeSummary = (): string | undefined => {
    const lines: string[] = [...changesRef.current.values()]
    // Explicit before/after comparisons for the settings outside the map.
    const nowTheme = themeSetting
    if (nowTheme !== snapshots.theme) lines.push(`set theme to ${nowTheme}`)
    if (lines.length === 0) return undefined
    return lines.join('\n')
  }

  const saveAndClose = (): void => {
    const summary = composeSummary()
    onClose(summary)
  }

  const revertAndClose = (): void => {
    if (!snapshots.dirty) {
      onClose(undefined)
      return
    }
    // 1 · theme first (its setter performs its own partial config write).
    setThemeSetting(snapshots.theme)
    // 2 · the TOUCHED global keys only, restored onto the CURRENT config —
    //     never the mount-time monolith wholesale: publishing the whole
    //     snapshot erased every write a SIBLING session made while the
    //     dialog stood (tab B's trust acceptance, MCP approvals, its
    //     worktree-return record — and any project record born after the
    //     mount was deleted outright), then write-throughed the stale view
    //     into this process's cache (TASK-017 S2,
    //     config-revert-publishes-stale-monolith). The lock's fresh re-read
    //     is now the base; only this dialog's own keys move back.
    if (globalTouchedRef.current.size > 0) {
      saveGlobalConfig(current => {
        const restored = { ...current } as Record<string, unknown>
        const snap = snapshots.global as unknown as Record<string, unknown>
        for (const key of globalTouchedRef.current) {
          if (snap[key] === undefined) delete restored[key]
          else restored[key] = snap[key]
        }
        return restored as unknown as GlobalConfig
      })
      globalTouchedRef.current.clear()
    }
    // 3 · each touched local key (undefined deletes).
    writeSource('localSettings', {
      spinnerTipsEnabled: snapshots.local.spinnerTipsEnabled,
      prefersReducedMotion: snapshots.local.prefersReducedMotion,
      instructionProfile: snapshots.local.instructionProfile,
    })
    // 4 · each touched user key. Permissions: ONLY defaultMode moves back —
    //     the key this dialog's mode toggle writes. The old wholesale
    //     restore of the mount-time permissions object erased any allow
    //     rule granted from a sibling session (or this one's consent cards)
    //     while the dialog stood (TASK-017 S2, the same stale-snapshot
    //     class as step 2).
    writeSource('userSettings', {
      alwaysThinkingEnabled: snapshots.user.alwaysThinkingEnabled,
      promptSuggestionEnabled: snapshots.user.promptSuggestionEnabled,
      autoUpdatesChannel: snapshots.user.autoUpdatesChannel,
      minimumVersion: snapshots.user.minimumVersion,
      language: snapshots.user.language,
      syntaxHighlightingDisabled: snapshots.user.syntaxHighlightingDisabled,
      // The one changed key, with the EXPLICIT undefined the writer's merge
      // requires for a delete — the old local-object delete pruned a copy
      // the merge never saw, so esc-revert could not clear a stale
      // defaultMode from disk (prove-settings-write-scope).
      permissions: { defaultMode: snapshots.user.permissions?.defaultMode } as never,
    })
    // 5 · batch-restore the touched app-state fields.
    setAppState(prev => ({ ...prev, verbose: snapshots.appVerbose }))
    const restoredProfile = snapshots.local.instructionProfile
    setSessionInstructionProfile(
      isInstructionProfile(restoredProfile) ? restoredProfile : null,
    )
    clearInstructionFileCaches()
    onClose(undefined)
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  useInput(
    (input, key, event) => {
      if (subMenu !== null) return
      if (headerFocused) return
      if (searchMode) {
        if (key.escape) {
          event.stopImmediatePropagation()
          if (query !== '') setQuery('')
          else {
            setSearchMode(false)
            revertAndClose()
          }
          return
        }
        if (key.return || key.downArrow) {
          event.stopImmediatePropagation()
          setSearchMode(false)
          moveTo(0)
          return
        }
        if (key.backspace || key.delete) {
          event.stopImmediatePropagation()
          setQuery(q => q.slice(0, -1))
          return
        }
        if (
          input !== '' &&
          !key.ctrl &&
          !key.meta &&
          !key.tab &&
          input >= ' ' &&
          input.charCodeAt(0) !== 0x7f
        ) {
          event.stopImmediatePropagation()
          setQuery(q => q + input)
        }
        return
      }
      // List mode.
      const item = filtered[selected]
      if (key.escape) {
        event.stopImmediatePropagation()
        revertAndClose()
        return
      }
      if (key.return) {
        event.stopImmediatePropagation()
        saveAndClose()
        return
      }
      if (key.upArrow) {
        event.stopImmediatePropagation()
        if (selected === 0) setSearchMode(true)
        else moveTo(selected - 1)
        return
      }
      if (key.downArrow) {
        event.stopImmediatePropagation()
        moveTo(selected + 1)
        return
      }
      if (key.leftArrow || key.rightArrow || key.tab) {
        if (item === undefined) return
        event.stopImmediatePropagation()
        const direction: 1 | -1 = key.leftArrow ? -1 : 1
        if (item.kind === 'managed-enum' && item.open !== undefined) {
          setSubMenu(item.open)
        } else {
          item.change?.(direction)
        }
        return
      }
      if (input === ' ') {
        event.stopImmediatePropagation()
        if (item?.kind === 'managed-enum' && item.open !== undefined) setSubMenu(item.open)
        else item?.change?.(1)
        return
      }
      if (input === '/') {
        event.stopImmediatePropagation()
        setSearchMode(true)
        return
      }
      // Any unbound printable that is not navigation/search/space/chord
      // re-enters search seeded with that character.
      if (
        input !== '' &&
        !key.ctrl &&
        !key.meta &&
        input >= ' ' &&
        input !== ' ' &&
        input.charCodeAt(0) !== 0x7f &&
        !['j', 'k'].includes(input)
      ) {
        event.stopImmediatePropagation()
        setSearchMode(true)
        setQuery(input)
        return
      }
      if (input === 'j') {
        event.stopImmediatePropagation()
        moveTo(selected + 1)
        return
      }
      if (input === 'k') {
        event.stopImmediatePropagation()
        if (selected > 0) moveTo(selected - 1)
      }
    },
    { isActive: subMenu === null },
  )

  // ── sub-menus (the tab row is hidden while one is open) ──────────────────
  if (subMenu === 'theme') {
    return (
      <Select
        options={REACHABLE_THEME_SETTINGS.map(setting => ({
          label: THEME_LABELS[setting] ?? setting,
          value: setting,
        }))}
        defaultValue={themeSetting}
        onChange={value => {
          setThemeSetting(value)
          snapshots.dirty = true
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'teammate-model') {
    const current = config.teammateDefaultModel
    return (
      <Select
        options={[
          { label: 'Default', value: '__default__' },
          { label: "Leader's model", value: '__leader__' },
        ]}
        defaultValue={current === null ? '__leader__' : '__default__'}
        onChange={value => {
          // Confirming Default from an UNSET value is a no-op: the picker
          // highlights Default when unset, and writing would silently switch
          // the fallback semantics.
          if (value === '__default__' && current === undefined) {
            setSubMenu(null)
            return
          }
          writeGlobal(c => ({
            ...c,
            teammateDefaultModel: value === '__leader__' ? null : undefined,
          }))
          recordSet(
            'teammateDefaultModel',
            `set default teammate model to ${value === '__leader__' ? "leader's model" : 'default'}`,
          )
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'language') {
    return (
      <LanguagePicker
        initialLanguage={merged.language}
        onComplete={language => {
          if (writeSource('userSettings', { language })) {
            snapshots.dirty = true
            recordSet('language', `set language to ${language ?? 'auto'}`)
          }
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'channel-downgrade') {
    return (
      <ChannelDowngradeDialog
        currentVersion={currentAppVersion()}
        onChoice={choice => {
          if (choice === 'cancel') {
            setSubMenu(null)
            return
          }
          const pin = choice === 'stay'
          if (
            writeSource('userSettings', {
              autoUpdatesChannel: 'stable',
              minimumVersion: pin ? currentAppVersion() : undefined,
            })
          ) {
            snapshots.dirty = true
            recordSet('autoUpdateChannel', `set auto-update channel to stable${pin ? ' (pinned)' : ''}`)
          }
          setSubMenu(null)
        }}
      />
    )
  }
  if (subMenu === 'external-includes') {
    return (
      <ExternalInstructionIncludesDialog
        isStandaloneDialog={false}
        externalIncludes={externalIncludes}
        onDone={() => {
          // Deliberately NOT marked dirty: this dialog's effect is its own
          // and is never undone by cancel.
          setSubMenu(null)
        }}
      />
    )
  }
  if (subMenu === 'auto-updates-info') {
    const reason = getAutoUpdaterDisabledReason()
    const fromConfiguration = reason !== null && reason.type === 'config'
    if (!fromConfiguration) {
      return (
        <Box flexDirection="column">
          <Text>
            Auto-updates are disabled:{' '}
            {reason !== null ? formatAutoUpdaterDisabledReason(reason) : 'unknown reason'}
          </Text>
          <Select
            options={[{ label: 'Back', value: 'back' }]}
            onChange={() => setSubMenu(null)}
            onCancel={() => setSubMenu(null)}
          />
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text>Auto-updates are disabled by configuration.</Text>
        <Select
          options={[
            { label: 'Re-enable on the latest channel', value: 'latest' },
            { label: 'Re-enable on the stable channel', value: 'stable' },
          ]}
          onChange={value => {
            writeGlobal(c => ({ ...c, autoUpdates: true }))
            if (
              writeSource('userSettings', {
                autoUpdatesChannel: value as 'latest' | 'stable',
                minimumVersion: undefined,
              })
            ) {
              recordSet('autoUpdateChannel', `re-enabled auto-updates on ${value}`)
            }
            setSubMenu(null)
          }}
          onCancel={() => setSubMenu(null)}
        />
      </Box>
    )
  }

  // ── the list ─────────────────────────────────────────────────────────────
  const visible = filtered.slice(offset, offset + windowSize)
  const hiddenAbove = offset
  const hiddenBelow = Math.max(0, filtered.length - offset - windowSize)
  const width = tabsWidth

  return (
    <Box flexDirection="column" width={width}>
      <SearchBox
        query={query}
        isFocused={searchMode && !headerFocused}
        isTerminalFocused={true}
        cursorOffset={query.length}
        placeholder="Search settings…"
      />
      {hiddenAbove > 0 ? (
        <Text dimColor>↑ {hiddenAbove} more</Text>
      ) : null}
      {visible.map((item, index) => {
        const at = offset + index
        const isSelected = !searchMode && at === selected
        return (
          <Box key={item.id} flexDirection="column">
            <Box flexDirection="row">
              <Box width={LABEL_CELLS} flexShrink={0}>
                <Text
                  bold={isSelected}
                  color={isSelected ? tokens.textPrimary : tokens.textSecondary}
                  wrap="truncate-end"
                >
                  {isSelected ? `${figures.pointer} ` : '  '}
                  {item.label}
                </Text>
              </Box>
              {item.value}
            </Box>
            {isSelected && item.warning !== undefined ? (
              <Text color={tokens.warning}>{'  '}{item.warning}</Text>
            ) : null}
          </Box>
        )
      })}
      {hiddenBelow > 0 ? (
        <Text dimColor>↓ {hiddenBelow} more</Text>
      ) : null}
      {filtered.length === 0 ? (
        <Text dimColor>no settings match “{query}”</Text>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          <KeyboardShortcutHint shortcut="↑/↓" action="select" />
          {' · '}
          <KeyboardShortcutHint shortcut="←/→" action="change" />
          {' · '}
          <KeyboardShortcutHint shortcut="Enter" action="save" />
          {' · '}
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="esc"
            description="revert"
          />
        </Text>
      </Box>
    </Box>
  )
}
