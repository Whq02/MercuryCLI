import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { LocalJSXCommandContext } from '../../commands.js'
import { enqueueNotification } from '../../context/notifications.js'
import { ModalContext } from '../../context/modalContext.js'
import { usePopupMarker } from '../../context/popupFormContext.js'
import { settingsPopupMarker } from '../../utils/cockpit/settingsPopup.js'
import { Box, Text, useInput } from '../../ink.js'
import { usePopupListPaging, PopupListViewport } from '../CustomSelect/popup-list.js'
import { escapeFromOutsidePress } from '../../ink/recessLayer.js'
import wrapText from '../../ink/wrap-text.js'
import { getFocusedWorkspaceCwd } from '../../hooks/useFocusedWorkspaceCwd.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { getGlobalConfigCacheStamp, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import { getEffectivePermissionMode } from '../../utils/config/derived.js'
import { describeSessionPermissionMode } from '../../utils/permissions/permissionSetup.js'
import {
  EDITOR_MODES,
  getGlobalConfig,
  saveGlobalConfig,
  getCustomApiKeyStatus,
  type GlobalConfig,
} from '../../utils/config.js'
import {
  updateSettingsForSource,
  getInitialSettings,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { DUCKDUCKGO_SETTING_KEY, DUCKDUCKGO_SETTING_LABEL, DUCKDUCKGO_TERMS, duckduckgoScrapingEnabled, duckduckgoScrapingPinned } from '../../services/search/searchSetting.js'
import { journalSettingOn } from '../../mneme/journalSetting.js'
import { readPinnedStatus } from '../../mneme/mnemeFrontPage.js'
import { runDueMaintenance } from '../../mneme/mnemeMaintenance.js'
import { memoryAtStartStatus } from '../../mneme/entryKnapsack.js'
import { formatTextSize, PINNED_TEXT_LIMIT_MIN, PINNED_TEXT_LIMIT_STEP, pinnedTextLimit, START_TEXT_LIMIT_MIN, START_TEXT_LIMIT_STEP, startTextLimit } from '../../mneme/mnemeUsage.js'
import { describeSemanticReadiness, EMBED_DEFAULT_MODEL, servableEmbedModelNames, WORD_MATCH_ONLY_WORDS } from '../../mneme/embedModels.js'
import { formatTokens } from '../../utils/format.js'
import {
  clearInstructionFileCaches,
} from '../../services/instructions/engine.js'
import {
  setSessionInstructionProfile,
  isInstructionProfile,
} from '../../services/instructions/profile.js'
import { isFullscreenActive } from '../../utils/fullscreen.js'
import inkInstances from '../../ink/instances.js'
import { stripFacts } from '../../context/surfaceRoute.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  PERMISSION_MODES,
  permissionModeTitle,
} from '../../utils/permissions/PermissionMode.js'
import { getEngineModel, modelDisplayString, renderModelName } from '../../utils/model/model.js'
import { glmThinkingLocked } from '../../services/providers/zai/glmPins.js'
import { modelThinkingAlwaysOn } from '../../utils/model/capabilities.js'
import { useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'
import { customPatienceSetting, patienceEnvPins, patienceOf, patienceWords } from '../../services/providers/patience.js'
import {
  ENGINE_SESSION_CEILING_DEFAULT,
  endEngineSession,
  engineSessionCeilingPinned,
  resetShellEngineResolution,
  resolveEngineSessionCeiling,
  resolveShellEngine,
} from '../../utils/shell/engineSession.js'
import { windowsBashAbsent } from '../../utils/shell/windowsShellRoad.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import {
  providerFamilyPresences,
  type ProviderFamilyPresence,
} from '../../services/providers/providerUsage.js'
import { shownIdentityWords } from '../../services/providers/providerIdentityLine.js'
import { REACHABLE_THEME_SETTINGS, THEME_LABELS as THEME_NAMES_BY_SETTING } from '../../utils/theme.js'
import { DEFAULT_THEME_SETTING } from '../../utils/systemTheme.js'
import { useTheme, useThemeSetting } from '../design-system/ThemeProvider.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import { SearchBox } from '../SearchBox.js'
import { Select } from '../CustomSelect/select.js'
import { LanguagePicker } from '../LanguagePicker.js'
import { ExternalInstructionIncludesDialog } from '../ExternalInstructionIncludesDialog.js'
import type { ExternalInstructionInclude } from '../../services/instructions/engine.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { SEAT_DOORS, seatCeilingFactsAsync, seatCeilingValueWords, seatCostWarning, setOperatorSeats, type SeatCeilingFacts } from '../../services/switchboard/capacityCheck.js'
import { MOTION_DOORS, MOTION_SETTINGS, motionDetailLines, motionValueWords, noteMotionSettingChanged, readMotionSetting, setMotionSetting } from '../../utils/cockpit/motionSetting.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { jevSessionFacts, jevSessionFactsStamp, jevSessionStatus, subscribeJevSessionFacts } from '../../services/jev/jevSessionFacts.js'
import { jevSettingLines, jevValueWords, readJevSettings, setJevEnabled } from '../../services/jev/jevSetting.js'
import { BACKGROUND_LAUNCH_DOORS, BACKGROUND_LAUNCH_KEY, BACKGROUND_LAUNCH_LABEL, BACKGROUND_LAUNCH_NOTE, BACKGROUND_LAUNCH_SUMMARY, backgroundLaunchValueWords, backgroundSessionsLaunchCrewmates, setBackgroundSessionsLaunchCrewmates } from '../../services/switchboard/backgroundLaunch.js'
import { jevStatusLine } from '../../services/jev/jevStatus.js'
import { subagentDefaultsOf } from '../../utils/agentDefaults.js'
import { agentFanoutCap } from '../../constants/subagentDoctrine.js'
import { EFFORT_LEVELS } from '../../utils/effort.js'
import { MercuryModelChoicePicker, modelChoiceLabel, modelChoiceRow } from '../../commands/model/mercuryModel.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'
import type { ModelChoice } from '../MercuryModelPicker.js'
import { LOCAL_PULL_RECOMMENDATION } from '../../services/providers/local/localAccounts.js'
import { LOCAL_SETUP_OFFER } from '../../commands/localsetup/words.js'
import { localRecordFor } from '../../services/providers/local/localCatalogue.js'
import { heldLocalWindow, localWindowApplication, localWindowRefusalWords, localWindowRoomWords, localWindowSettingOf, localWindowValueWords, nextLocalWindowSetting, writeLocalWindowSetting, localWindowSettingWords } from '../../services/providers/local/localWindow.js'
import { LOCAL_SERVER_APPLY_MENU, LocalServerApplyDialog, localServerConfigItems, useLocalServerConfig } from './LocalServer.js'
import { advisorConfigItems } from './Advisor.js'
import { MediaConfigPicker, useMediaConfig, type MediaMenu } from './Media.js'
import { reloadExtensions, noteReloaded } from '../../extensions/boot.js'
import { extensionsStateFrom } from '../../hooks/useExtensions.js'
import { setAdvisorEnabled, setAdvisorMinutes } from '../../services/advisor/advisorSettings.js'

const LABEL_CELLS = 36

export const CONFIG_POPUP_WIDTH = 110
export const CONFIG_POPUP_ROWS = 44
export const CONFIG_POPUP_HINT = '↑↓ select · pgup/pgdn page · ←/→ change · ↵ save · / search · esc or click outside closes'
export const CONFIG_SEARCH_PLACEHOLDER = 'Search settings…'
export const CONFIG_LIST_CHROME_ROWS = 3
export const CONFIG_ROW_MARK = GLYPH.chevronRight

export function configPopupLine(folder: string, settings: number, setByYou: number): string {
  return `${folder} · ${settings} setting${settings === 1 ? '' : 's'} · ${setByYou} set by you`
}

export function configPopupFolder(cwd: string = getFocusedWorkspaceCwd()): string {
  const name = basename(cwd)
  return name === '' ? cwd : name
}

export function configMoreRow(hiddenBelow: number): string {
  return hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : ''
}

export function configWarningRows(warning: string, width: number): number {
  return wrapText(`  ${warning}`, Math.max(1, width), 'wrap').split('\n').length
}

export type ConfigListWindow = { sel: number; off: number; hiddenBelow: number; overflows: boolean }

export function configListWindow(selected: number, offset: number, total: number, windowSize: number): ConfigListWindow {
  const size = Math.max(1, windowSize)
  const sel = Math.max(0, Math.min(selected, total - 1))
  let off = offset
  if (sel < off) off = sel
  if (sel >= off + size) off = sel - size + 1
  off = Math.max(0, Math.min(off, Math.max(0, total - size)))
  return { sel, off, hiddenBelow: Math.max(0, total - off - size), overflows: total > size }
}

type SubMenu =
  | 'theme'
  | 'agent-model'
  | 'external-includes'
  | 'language'
  | typeof LOCAL_SERVER_APPLY_MENU
  | MediaMenu

const AGENT_INHERIT_ROW: ModelChoice = { id: 'inherit', name: 'Inherit', tag: "the parent's model", ctx: '', group: 'Crewmate', choice: "uses the parent session's model when spawning a crewmate" }

type ItemKind = 'boolean' | 'enum' | 'managed-enum' | 'info'

type SettingsItem = {
  id: string
  label: string
  searchText?: string
  kind: ItemKind
  value: React.ReactNode
  change?: (direction: 1 | -1) => void
  open?: SubMenu
  warning?: string
  setByYou?: boolean
}

const THEME_LABELS: Record<string, string> = { auto: 'auto', ...THEME_NAMES_BY_SETTING }


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
  xai: { label: 'xAI', absent: 'no key — /logins xai connects (or XAI_API_KEY)', manage: '/accounts' },
  meta: { label: 'Meta', absent: 'no key — /logins meta connects (or MODEL_API_KEY)', manage: '/accounts' },
  mistral: { label: 'Mistral', absent: 'no key — /logins mistral connects (or MISTRAL_API_KEY)', manage: '/accounts' },
  'openai-compat': { label: 'Custom endpoint', absent: 'not configured — MERCURY_COMPAT_BASE_URL' },
  huggingface: { label: 'Hugging Face', absent: 'not signed in — /logins connects (or HF_TOKEN)', manage: '/accounts' },
  local: { label: 'Local', absent: `no sign-in — start a local server or MERCURY_LOCAL_BASE_URL, then ${LOCAL_PULL_RECOMMENDATION}, ${LOCAL_SETUP_OFFER}` },
  nous: { label: 'Nous Portal', absent: 'no key — /logins nous connects (or NOUS_API_KEY)', manage: '/accounts' },
  zen: { label: 'OpenCode Zen', absent: 'no key — /logins zen connects (or OPENCODE_API_KEY)', manage: '/accounts' },
  minimax: { label: 'MiniMax', absent: 'no key — /logins minimax connects (or MINIMAX_API_KEY)', manage: '/accounts' },
  together: { label: 'Together AI', absent: 'no key — /logins together connects (or TOGETHER_API_KEY)', manage: '/accounts' },
  cohere: { label: 'Cohere', absent: 'no key — /logins cohere connects (or COHERE_API_KEY)', manage: '/accounts' },
  groq: { label: 'Groq', absent: 'no key — /logins groq connects (or GROQ_API_KEY)', manage: '/accounts' },
  melious: { label: 'Melious AI', absent: 'no key — /logins melious connects (or MELIOUS_API_KEY)', manage: '/accounts' },
  orcarouter: { label: 'OrcaRouter', absent: 'no key — /logins orcarouter connects (or ORCAROUTER_API_KEY)', manage: '/accounts' },
  cerebras: { label: 'Cerebras', absent: 'no key — /logins cerebras connects (or CEREBRAS_API_KEY)', manage: '/accounts' },
  fireworks: { label: 'Fireworks', absent: 'no key — /logins fireworks connects (or FIREWORKS_API_KEY)', manage: '/accounts' },
  qwen: { label: 'Qwen', absent: 'no key — /logins qwen connects (or DASHSCOPE_API_KEY)', manage: '/accounts' },
}


export function configRowApplicability(
  appliesTo: 'anthropic' | 'openrouter',
  route: string,
): { applies: true } | { applies: false; naText: string; refuseNote: string } {
  if (route === appliesTo) return { applies: true }
  const laneLabel = CONFIG_PROVIDER_PRESENTATION[appliesTo]?.label ?? appliesTo
  const activeLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
  return {
    applies: false,
    naText: `n/a — applies to ${laneLabel} models (${activeLabel} is active)`,
    refuseNote: `This setting only affects ${laneLabel}; the session runs on ${activeLabel} — /model switches provider.`,
  }
}

export function thinkingRowApplicability(
  model: string,
  reads?: { locked?: (id: string) => boolean; routeOf?: (id: string) => string | null; alwaysOn?: (id: string) => boolean; nameOf?: (id: string) => string },
): { applies: true } | { applies: false; naText: string; refuseNote: string } {
  const route = reads?.routeOf?.(model) ?? declaredRouteOf(model)
  if (route === 'openai') {
    return {
      applies: false,
      naText: `n/a — GPT models take the effort dial (${model} is active)`,
      refuseNote: 'GPT reasoning is the effort level; /effort sets it, and /model switches provider.',
    }
  }
  if (route === 'zai' && (reads?.locked ?? glmThinkingLocked)(model)) {
    return {
      applies: false,
      naText: `n/a — ${model} keeps thinking on`,
      refuseNote: 'This model locks thinking on at the provider; the setting cannot turn it off.',
    }
  }
  if ((reads?.alwaysOn ?? modelThinkingAlwaysOn)(model)) {
    return {
      applies: false,
      naText: `n/a — ${(reads?.nameOf ?? renderModelName)(model)} keeps thinking on`,
      refuseNote: 'This model thinks on every request; the setting cannot turn it off — /effort is the lever.',
    }
  }
  return { applies: true }
}

export function mainLoopPointerText(
  effective: string | null,
  reads?: { resolvedModel?: () => string; routeOf?: (model: string) => string },
): string {
  const resolved = reads?.resolvedModel?.() ?? getEngineModel()
  const model = effective ?? resolved
  const route = reads?.routeOf?.(model) ?? declaredRouteOf(model) ?? 'unrecognised'
  const providerLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
  const modelText =
    effective !== null ? modelDisplayString(effective) : `default (${modelDisplayString(resolved)})`
  return `${providerLabel} · ${modelText} — /model`
}

export function localModelWindowRow(
  record: ReturnType<typeof localRecordFor>,
  route: string,
  _stamp?: number,
): { applies: boolean; valueText: string; note: string; setByYou: boolean; overFit: boolean; tight: boolean } {
  if (route !== 'local' || record === undefined) {
    const activeLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
    return {
      applies: false,
      valueText: `n/a — applies to local models (${activeLabel} is active)`,
      note: 'The served context window of a local model — /model picks a local model first; then ←/→ choose server default · 32k · 64k · 128k · trained max, or auto (the biggest window that fits this machine, chosen at first send and held for the session).',
      setByYou: false,
      overFit: false,
      tight: false,
    }
  }
  const setting = localWindowSettingOf(record)
  const application = localWindowApplication(record)
  const applies = application === 'request' || application === 'load'
  const refusal = applies ? localWindowRefusalWords(record, setting) : undefined
  const room = applies && refusal === undefined ? localWindowRoomWords(record, setting) : undefined
  const held = applies ? heldLocalWindow(record) : undefined
  const rule = held !== undefined && held.setting === setting && held.window !== undefined ? ` Held this session: ${held.words}.` : ''
  const note =
    application === 'server-start'
      ? `${record.id}: this server fixes its window when it starts; Mercury shows the served figure and cannot change it here.`
      : application === 'none'
        ? `${record.id}: an unknown server kind — the setting does not apply.`
        : `${record.id}: auto = the biggest of 32k · 64k · 128k · 256k whose projected load (weights + the KV cache of the layers that keep one, at the server's cache type and slots; the server's measured size once the model is loaded) fits the memory usable for models, never above the trained max — the rule /localsetup's step 5 uses; held for the session; a change reloads the model on the next send (the ingested prompt is read again).${refusal !== undefined ? ` The setting is saved but does not fit: ${refusal}.` : room !== undefined ? ` The setting fits this small box but leaves little room: ${room}.` : ''}${rule} ${application === 'request' ? 'Ollama takes it as num_ctx on every request.' : 'LM Studio takes it when the model is loaded.'}`
  return { applies, valueText: `${localWindowValueWords(record, setting)} · ${record.id}`, note, setByYou: applies && setting !== undefined, overFit: refusal !== undefined, tight: room !== undefined }
}

export interface ConfigProviderRow {
  id: string
  label: string
  valueText: string
  credentialed: boolean
}

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
          ? `${shownIdentityWords(family.id, String(family.credentialLabel))}${meta.manage ? ` — ${meta.manage}` : ''}`
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

const SESSION_CEILING_LADDER: readonly number[] = [1, 2, 4, 8, 12, 16, 24, 32]
function nextSessionCeiling(current: number, direction: 1 | -1): number {
  if (direction === 1) return SESSION_CEILING_LADDER.find(rung => rung > current) ?? (SESSION_CEILING_LADDER[0] as number)
  for (let i = SESSION_CEILING_LADDER.length - 1; i >= 0; i--) {
    const rung = SESSION_CEILING_LADDER[i] as number
    if (rung < current) return rung
  }
  return SESSION_CEILING_LADDER[SESSION_CEILING_LADDER.length - 1] as number
}

function validated<T extends string>(
  list: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

type ConfigUndoSource = 'global' | 'localSettings' | 'userSettings' | 'app'
type ConfigUndo = { source: ConfigUndoSource; path: string[]; previous: unknown }

function configObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configUndoLeaves(source: ConfigUndoSource, before: unknown, after: unknown, path: string[] = [], partial = false): ConfigUndo[] {
  if (isDeepStrictEqual(before, after)) return []
  if ((configObject(before) || before === undefined) && (configObject(after) || after === undefined)) {
    const old = before ?? {}
    const next = after ?? {}
    const keys = partial && after !== undefined ? Object.keys(next) : new Set([...Object.keys(old), ...Object.keys(next)])
    return [...keys].flatMap(key => configUndoLeaves(source, old[key], next[key], [...path, key], partial))
  }
  return [{ source, path, previous: structuredClone(before) }]
}

function restoreConfigLeaf(current: Record<string, unknown>, path: string[], previous: unknown): Record<string, unknown> {
  const [key, ...tail] = path
  if (key === undefined) return current
  const restored = { ...current }
  const value = tail.length === 0 ? previous : restoreConfigLeaf(configObject(current[key]) ? current[key] : {}, tail, previous)
  if (value === undefined || (tail.length > 0 && configObject(value) && Object.keys(value).length === 0)) delete restored[key]
  else Object.defineProperty(restored, key, { value, enumerable: true, configurable: true, writable: true })
  return restored
}

export function Config({
  onClose,
  onLine,
  onOwnsEscape,
  context,
  width,
  contentHeight,
  compact = false,
}: {
  onClose: (result?: unknown) => void
  onLine?: (line: string) => void
  onOwnsEscape?: (owns: boolean) => void
  context: LocalJSXCommandContext
  width: number
  contentHeight: number
  compact?: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const setAppState = useSetAppState()
  const appState = useAppState((s: AppState) => s)
  const [, setThemeSetting] = useTheme()
  const themeSetting = useThemeSetting()
  const pastOpenEvent = useOpenEventGate()

  const [version, setVersion] = useState(0)
  const bump = (): void => setVersion(v => v + 1)
  void version
  const config = getGlobalConfig()
  const merged = getInitialSettings() as SettingsJson

  const undoRef = useRef<ConfigUndo[]>([])
  const dirtyRef = useRef(false)
  const initialThinking = useRef(merged.engine?.reasoning !== false)
  const mountTheme = useRef(themeSetting)

  const changesRef = useRef(new Map<string, string>())
  const recordToggle = (key: string, text: string): void => {
    dirtyRef.current = true
    if (changesRef.current.has(key)) changesRef.current.delete(key)
    else changesRef.current.set(key, text)
  }
  const recordSet = (key: string, text: string): void => {
    dirtyRef.current = true
    changesRef.current.delete(key)
    changesRef.current.set(key, text)
  }

  const writeSource = (
    source: 'localSettings' | 'userSettings',
    partial: Partial<SettingsJson>,
  ): boolean => {
    let undo: ConfigUndo[] = []
    const { error } = updateSettingsForSource(source, raw => {
      undo = configUndoLeaves(source, raw, partial, [], true)
      return partial
    })
    if (error !== null) {
      writeFailed(source, error)
      return false
    }
    undoRef.current.push(...undo)
    dirtyRef.current = true
    return true
  }
  const writeFailed = (source: 'localSettings' | 'userSettings', error: Error): void => {
    logForDebugging(`settings write failed (${source}): ${error.message}`)
    enqueueNotification(setAppState, {
      key: 'config-write-failed',
      text: `that change did not save — ${source === 'localSettings' ? 'project-local' : 'user'} settings write failed: ${error.message}`,
      priority: 'high',
      color: 'error',
      timeoutMs: 15_000,
    })
  }
  const writeGlobal = (mutate: (config: GlobalConfig) => GlobalConfig): void => {
    let undo: ConfigUndo[] = []
    saveGlobalConfig(current => {
      const next = mutate(current)
      undo = configUndoLeaves('global', current, next)
      return next
    })
    undoRef.current.push(...undo)
    dirtyRef.current = true
    bump()
  }

  const [subMenu, setSubMenu] = useState<SubMenu | null>(null)
  useEffect(() => {
    onOwnsEscape?.(true)
    return () => onOwnsEscape?.(false)
  }, [onOwnsEscape])
  const [thinkingWarning, setThinkingWarning] = useState(false)

  const conversationHasAssistantTurn = context.messages.some(
    message => message.type === 'assistant',
  )
  const thinkingOn = merged.engine?.reasoning !== false
  const permissions = merged.guardrails ?? {}
  const defaultMode = validated(
    PERMISSION_MODES,
    permissions.mode,
    'default',
  )
  const sessionMode = getEffectivePermissionMode(appState.toolPermissionContext.mode)
  const sessionModeDiffers = sessionMode.source !== 'session-choice' && sessionMode.mode !== defaultMode
  const modeOptions: ReadonlyArray<(typeof PERMISSION_MODES)[number]> = ['default', 'implement', 'apollo', 'flow', 'dontAsk']

  const boolValue = (on: boolean): React.ReactNode => (
    <Text color={on ? tokens.success : tokens.textSecondary}>
      {on ? 'on' : 'off'}
    </Text>
  )

  const servedModel = useFocusedServedModel()
  const mainRoute = declaredRouteOf(
    servedModel ?? appState.engineModelForSession ?? appState.engineModel ?? getEngineModel(),
  )
  const providerScoped = (item: SettingsItem, appliesTo: 'anthropic' | 'openrouter'): SettingsItem => {
    const applicability = configRowApplicability(appliesTo, mainRoute ?? 'unrecognised')
    if (applicability.applies) return item
    return {
      ...item,
      value: <Text color={tokens.textSecondary}>{applicability.naText}</Text>,
      warning: applicability.refuseNote,
      change: () => {},
    }
  }

  const media = useMediaConfig()
  const items: SettingsItem[] = []

  items.push({
    id: 'autoCompact',
    label: 'Auto-compact',
    kind: 'boolean',
    setByYou: config.autoCompactEnabled === false,
    value: boolValue(config.autoCompactEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, autoCompactEnabled: c.autoCompactEnabled === false }))
      recordToggle('autoCompact', `set auto-compact to ${config.autoCompactEnabled === false ? 'on' : 'off'}`)
    },
  })
  const WINDOW_RUNGS: ReadonlyArray<number | undefined> = [undefined, 100_000, 200_000, 500_000, 1_000_000]
  const windowIdx = Math.max(0, WINDOW_RUNGS.findIndex(rung => rung === config.autoCompactWindow))
  const windowWords = (rung: number | undefined): string => (rung === undefined ? 'auto' : formatTokens(rung))
  items.push({
    id: 'autoCompactWindow',
    label: 'Auto-compact window',
    searchText: 'auto compact window context tokens condense threshold',
    kind: 'enum',
    setByYou: config.autoCompactWindow !== undefined,
    value: <Text>{windowWords(WINDOW_RUNGS[windowIdx])}</Text>,
    warning: `the window auto-compact aims for; ${windowIdx === 0 ? 'auto picks one tuned to the model' : 'a manual override can cost more tokens on long sessions'}`,
    change: direction => {
      const nextIdx = Math.min(WINDOW_RUNGS.length - 1, Math.max(0, windowIdx + (direction > 0 ? 1 : -1)))
      if (nextIdx === windowIdx) return
      const next = WINDOW_RUNGS[nextIdx]
      writeGlobal(c => ({ ...c, autoCompactWindow: next }))
      recordSet('autoCompactWindow', `set the auto-compact window to ${windowWords(next)}`)
    },
  })
  const world = stripFacts()
  items.push({
    id: 'concourse',
    label: 'Session concourse',
    searchText: 'session concourse coordinator live view concourse-off chat plain world',
    kind: 'boolean',
    setByYou: config.concourseEnabled === false,
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
  const [seatFacts, setSeatFacts] = useState<SeatCeilingFacts | null>(null)
  const configStamp = useSyncExternalStore(subscribeGlobalConfigCache, getGlobalConfigCacheStamp, getGlobalConfigCacheStamp)
  useEffect(() => {
    let active = true
    void seatCeilingFactsAsync().then(facts => { if (active) setSeatFacts(facts) })
    return () => { active = false }
  }, [version, configStamp])
  const jevStamp = useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)
  const localServer = useLocalServerConfig(version)
  const seatWarning = seatFacts === null ? null : seatCostWarning(seatFacts)
  items.push({
    id: 'seats',
    label: 'Seats',
    searchText: 'seats seat ceiling capacity concurrency sessions crewmates workflow crewmates in flight',
    kind: 'enum',
    value: <Text>{seatFacts === null ? 'reading capacity…' : seatCeilingValueWords(seatFacts)}</Text>,
    setByYou: seatFacts !== null && seatFacts.source === 'operator',
    warning: seatFacts === null ? 'reading capacity…' : seatWarning !== null ? seatWarning : `a seat is one model call in flight; ${seatFacts.readingSentence} · ←/→ move the ceiling by one · doors: ${SEAT_DOORS}`,
    change: direction => {
      if (seatFacts === null) return
      const next = direction > 0 ? seatFacts.seats + 1 : Math.max(1, seatFacts.seats - 1)
      const after = setOperatorSeats(next, writeGlobal)
      setSeatFacts(after)
      recordSet('seats', `set the seat ceiling to ${after.seats}`)
      bump()
    },
  })
  items.push({
    id: 'tips',
    label: 'Tips',
    kind: 'boolean',
    setByYou: merged.activity?.tips?.enabled !== undefined,
    value: boolValue(merged.activity?.tips?.enabled !== false),
    change: () => {
      const next = merged.activity?.tips?.enabled === false
      if (writeSource('localSettings', { activity: { tips: { enabled: next ? undefined : false } } })) {
        recordToggle('tips', `set tips to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'reducedMotion',
    label: 'Reduced motion',
    kind: 'boolean',
    setByYou: merged.view?.reducedMotion !== undefined,
    value: boolValue(merged.view?.reducedMotion === true),
    change: () => {
      const next = merged.view?.reducedMotion !== true
      if (writeSource('localSettings', { view: { reducedMotion: next ? true : undefined } })) {
        recordToggle('reducedMotion', `set reduced motion to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'ping',
    label: 'Ping',
    searchText: 'ping terminal bell iterm2 notification turn finished away',
    kind: 'boolean',
    setByYou: merged.view?.ping !== undefined,
    value: boolValue(merged.view?.ping !== false),
    warning: 'Notify when a turn finishes while you are away: iTerm2 notification or terminal bell.',
    change: () => {
      const next = merged.view?.ping === false
      if (writeSource('userSettings', { view: { ping: next ? undefined : false } })) {
        recordToggle('ping', `set the ping to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'accountIdentity',
    label: 'Account identity',
    searchText: 'account identity email address username key tail hide hidden shown recording privacy',
    kind: 'boolean',
    setByYou: merged.view?.accountIdentity !== undefined,
    value: (
      <Text color={merged.view?.accountIdentity !== false ? tokens.success : tokens.textSecondary}>
        {merged.view?.accountIdentity !== false ? 'shown' : 'hidden'}
      </Text>
    ),
    warning: 'Hide addresses, usernames and key tails for recording. Logins, /accounts and /health still show them.',
    change: () => {
      const next = merged.view?.accountIdentity === false
      if (writeSource('userSettings', { view: { accountIdentity: next ? undefined : false } })) {
        recordToggle('accountIdentity', `set account identity to ${next ? 'shown' : 'hidden'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'zen',
    label: 'Zen mode — rails hidden',
    searchText: 'zen mode rails hidden lanes vitals full width chat',
    kind: 'boolean',
    setByYou: merged.view?.zen !== undefined,
    value: boolValue(merged.view?.zen === true),
    warning: 'Hide the side rails for full-width chat. /zen also toggles this.',
    change: () => {
      const next = merged.view?.zen !== true
      if (!writeSource('userSettings', { view: { zen: next ? true : undefined } })) return
      settingsChangeDetector.notifyChange('userSettings')
      recordToggle('zen', `set zen mode to ${next ? 'on' : 'off'}`)
      bump()
    },
  })
  {
    const motionSetting = readMotionSetting()
    items.push({
      id: 'motion',
      label: 'Motion',
      kind: 'enum',
      setByYou: motionSetting !== 'auto',
      value: <Text>{motionValueWords(motionSetting)}</Text>,
      warning: `${motionDetailLines().slice(0, 2).join(' · ')} · auto = full until painting falls behind, then reduced · full never reduces · reduced slows the clock and stills the critter · off stops idle motion · doors: ${MOTION_DOORS}`,
      change: direction => {
        const next = cycleIn(MOTION_SETTINGS, motionSetting, direction)
        setMotionSetting(next, writeGlobal)
        recordSet('motion', `set motion to ${next}`)
        bump()
      },
    })
  }
  {
    const enabled = duckduckgoScrapingEnabled()
    const pinned = duckduckgoScrapingPinned()
    items.push({
      id: DUCKDUCKGO_SETTING_KEY,
      label: DUCKDUCKGO_SETTING_LABEL,
      searchText: 'web search keyless DuckDuckGo page scraping terms',
      kind: 'boolean',
      setByYou: config.duckduckgoScraping !== undefined || pinned,
      value: <Text>{enabled ? 'on' : 'off'}{pinned ? ' · set by env' : ''}</Text>,
      warning: `on by default; off keeps general queries to the official sources and your keys · ${DUCKDUCKGO_TERMS}${pinned ? ' · MERCURY_SEARCH_KEYLESS decides this process; change that environment variable to change the effective value' : ''}`,
      change: () => {
        if (pinned) return
        writeGlobal(current => ({ ...current, [DUCKDUCKGO_SETTING_KEY]: !enabled }))
        recordToggle(DUCKDUCKGO_SETTING_KEY, `set ${DUCKDUCKGO_SETTING_LABEL} ${enabled ? 'off' : 'on'}`)
        bump()
      },
    })
  }
  {
    const jevSettings = readJevSettings()
    items.push({
      id: 'jev',
      label: 'JEV',
      searchText: 'jev typesafe official openrouter road second opinion jeveval eval tool key allowance pace ceiling crewmates',
      kind: 'boolean',
      setByYou: jevSettings.enabled,
      value: <Text color={jevSettings.enabled ? tokens.success : tokens.textSecondary}>{jevValueWords(jevSettings)}</Text>,
      warning: [jevStatusLine(jevSessionStatus(jevSessionFacts(), jevSettings)), ...jevSettingLines(jevSettings)].join(' · '),
      change: () => {
        const next = !jevSettings.enabled
        setJevEnabled(next, undefined, writeGlobal)
        recordToggle('jev', `set JEV to ${jevValueWords({ ...jevSettings, enabled: next })}`)
        bump()
      },
    })
  }
  items.push({
    id: 'briefs.profile',
    label: 'Instruction profile',
    kind: 'enum',
    setByYou: merged.briefs?.profile !== undefined,
    value: <Text>{merged.briefs?.profile ?? 'auto'}</Text>,
    change: direction => {
      const profiles = ['auto', 'native'] as const
      const current = validated(profiles, merged.briefs?.profile, 'auto')
      const next = cycleIn(profiles, current, direction)
      if (writeSource('localSettings', { briefs: { profile: next } })) {
        setSessionInstructionProfile(next === 'auto' ? null : isInstructionProfile(next) ? next : null)
        clearInstructionFileCaches()
        recordSet('briefs.profile', `set instruction profile to ${next}`)
        bump()
      }
    },
  })
  {
    const engineSetting = validated(['system', 'brush'] as const, merged.shell?.engine, 'system')
    const resolved = resolveShellEngine(engineSetting)
    const detail =
      engineSetting === 'brush' && resolved.engine !== 'brush'
        ? ' · unavailable, system shell in use'
        : resolved.engine === 'brush'
          ? ` · brush ${resolved.version}`
          : ''
    items.push({
      id: 'shell.engine',
      label: 'Shell engine',
      kind: 'enum',
      setByYou: merged.shell?.engine !== undefined,
      value: <Text>{engineSetting}{detail}</Text>,
      warning:
        engineSetting === 'brush' && resolved.engine !== 'brush'
          ? 'The vendored shell engine pack is not present in this build; the system shell runs instead.'
          : undefined,
      change: direction => {
        const engines = ['system', 'brush'] as const
        const next = cycleIn(engines, engineSetting, direction)
        if (writeSource('localSettings', { shell: { engine: next === 'system' ? undefined : next } })) {
          recordSet('shell.engine', `set shell engine to ${next}`)
          resetShellEngineResolution()
          void endEngineSession()
          bump()
        }
      },
    })
  }
  {
    const patience = patienceOf(merged.patience)
    const patiencePins = patienceEnvPins()
    items.push({
      id: 'patience',
      label: 'Patience with a quiet model',
      searchText: 'patience quiet model stream idle watchdog stuck silent fallback retry budget timeout wait slow link',
      kind: 'enum',
      setByYou: merged.patience !== undefined,
      value: (
        <Text>
          {patience.mode}
          <Text color={tokens.textSecondary}> · {patienceWords(patience.numbers)}</Text>
          {patiencePins.length > 0 ? (
            <Text color={tokens.textSecondary}> · {patiencePins.join(' ')} outranks it this boot</Text>
          ) : null}
        </Text>
      ),
      warning:
        'applies to every provider: stream idle (6 min with keep-alives; 15 min on quiet streams), the non-streamed fallback ceiling and the retry budget · patient doubles the waits, including the 30 s wait for a first body byte after headers · custom raises that first-byte wait in proportion to the idle budget and writes the numbers to your user settings file to edit (patience: streamIdleSeconds · quietStreamIdleSeconds · fallbackCeilingSeconds · recoveryBudgetMinutes) · ←/→ walk the modes',
      change: direction => {
        const modes = ['normal', 'patient', 'custom'] as const
        const next = cycleIn(modes, patience.mode, direction)
        const value =
          next === 'normal' ? undefined : next === 'patient' ? 'patient' : customPatienceSetting(patience.numbers)
        if (writeSource('userSettings', { patience: value })) {
          recordSet('patience', `set patience with a quiet model to ${next}`)
          bump()
        }
      },
    })
  }
  {
    const routing = merged.routing?.openrouter
    const collection = routing?.dataCollection ?? 'deny'
    const parameters = routing?.requireParameters ?? true
    const fallbacks = routing?.allowFallbacks ?? true
    const zdr = routing?.zeroDataRetention ?? false
    items.push(providerScoped({
      id: 'routing.openrouter',
      label: 'OpenRouter routing policy',
      searchText: 'openrouter routing policy privacy collection parameters fallbacks zero data retention zdr',
      kind: 'enum',
      setByYou: merged.routing?.openrouter !== undefined,
      value: <Text>{`${collection} · parameters ${parameters ? 'required' : 'optional'} · fallbacks ${fallbacks ? 'on' : 'off'} · ZDR ${zdr ? 'on' : 'off'}`}</Text>,
      warning: 'the endpoints OpenRouter may use · strict denies data collection, requires every parameter, turns fallbacks off and zero data retention on · balanced is on from the start: denies collection and requires parameters, with fallbacks on and ZDR off · open leaves routing to OpenRouter · a model with no matching endpoint refuses with the no-provider error; allow collection or relax parameters to widen the pool · ←/→ walk strict, balanced, open · edit routing.openrouter in your user settings for each switch: dataCollection, requireParameters, allowFallbacks, zeroDataRetention',
      change: direction => {
        const modes = ['strict', 'balanced', 'open'] as const
        const current = collection === 'allow' && !parameters && fallbacks && !zdr ? 'open' : collection === 'deny' && parameters && !fallbacks && zdr ? 'strict' : 'balanced'
        const next = cycleIn(modes, current, direction)
        const value = {
          dataCollection: next === 'open' ? 'allow' as const : 'deny' as const,
          requireParameters: next !== 'open',
          allowFallbacks: next !== 'strict',
          zeroDataRetention: next === 'strict',
        }
        if (writeSource('userSettings', { routing: { openrouter: value } })) {
          recordSet('routing.openrouter', `set OpenRouter routing policy to ${next}`)
          bump()
        }
      },
    }, 'openrouter'))
  }
  {
    const ceiling = resolveEngineSessionCeiling(merged.shell?.sessions)
    const pinned = engineSessionCeilingPinned()
    const share = ceiling === 1 ? 'no session for crewmates' : `the conversation + ${ceiling - 1} crewmate${ceiling === 2 ? '' : 's'}`
    items.push({
      id: 'shell.sessions',
      label: 'Shell engine sessions',
      kind: 'enum',
      setByYou: merged.shell?.sessions !== undefined,
      value: <Text>{ceiling} · {share}{pinned ? ' · pinned by MERCURY_SHELL_ENGINE_SESSIONS' : ''}</Text>,
      warning: pinned
        ? 'MERCURY_SHELL_ENGINE_SESSIONS decides the ceiling for this process; a value written here applies once that environment variable is unset.'
        : ceiling === 1
          ? `A ceiling of 1 keeps the main conversation's session only: a crewmate's engine call is refused with the reason (a run_in_background call still runs, in its own ${windowsBashAbsent() ? 'engine process' : 'system shell'}).`
          : undefined,
      change: direction => {
        const next = nextSessionCeiling(merged.shell?.sessions ?? ENGINE_SESSION_CEILING_DEFAULT, direction)
        if (writeSource('localSettings', { shell: { sessions: next === ENGINE_SESSION_CEILING_DEFAULT ? undefined : next } })) {
          recordSet('shell.sessions', `set shell engine sessions to ${next}`)
          bump()
        }
      },
    })
  }
  {
    const thinkingApplicability = thinkingRowApplicability(servedModel ?? appState.engineModelForSession ?? appState.engineModel ?? getEngineModel())
    items.push({
      id: 'thinking',
      label: 'Thinking',
      searchText: 'thinking reasoning think reason extended',
      kind: 'boolean',
      setByYou: merged.engine?.reasoning !== undefined,
      value: thinkingApplicability.applies ? boolValue(thinkingOn) : <Text color={tokens.textSecondary}>{thinkingApplicability.naText}</Text>,
      warning:
        !thinkingApplicability.applies
          ? thinkingApplicability.refuseNote
          : thinkingWarning && conversationHasAssistantTurn
            ? 'Thinking raises latency and can reduce quality mid-conversation.'
            : 'the model reasons before it answers; on is the default · off asks the model not to — Sonnet 5.5 and Opus 5.5 keep thinking on regardless · engine.reasoning in settings',
      change: () => {
        if (!thinkingApplicability.applies) return
        const next = !thinkingOn
        if (writeSource('userSettings', { engine: { reasoning: next ? undefined : false } })) {
          recordToggle('thinking', `set thinking to ${next ? 'on' : 'off'}`)
          if (conversationHasAssistantTurn) {
            const initial = initialThinking.current
            setThinkingWarning(next !== initial)
          }
          bump()
        }
      },
    })
  }
  items.push({
    id: 'usageNotice',
    label: 'Usage notice to the model',
    searchText: 'usage notice model told limit warning window spend 80 90 tokens awareness',
    kind: 'boolean',
    setByYou: merged.engine?.usageNotice !== undefined,
    value: boolValue(merged.engine?.usageNotice === true),
    warning: 'Tell the model at 80% and 90% of a usage window or spending limit. Your meters stay visible either way.',
    change: () => {
      const next = merged.engine?.usageNotice !== true
      if (writeSource('userSettings', { engine: { usageNotice: next ? true : undefined } })) {
        recordToggle('usageNotice', `set usage notice to the model to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'toolOutput',
    label: 'Tool output',
    kind: 'enum',
    setByYou: appState.verbose === true,
    value: <Text>{appState.verbose === true ? 'full' : 'compact'}</Text>,
    change: direction => {
      const levels = ['compact', 'full'] as const
      const next = cycleIn(levels, appState.verbose === true ? 'full' : 'compact', direction)
      undoRef.current.push({ source: 'app', path: ['verbose'], previous: appState.verbose })
      setAppState(prev => ({ ...prev, verbose: next === 'full' }))
      recordToggle('toolOutput', `set tool output to ${next}`)
    },
  })
  const progressPin = merged.activity?.progress
  const progressBarOn = config.terminalProgressBarEnabled !== false && progressPin !== false
  items.push({
    id: 'terminalProgressBar',
    label: 'Terminal progress bar',
    searchText: 'terminal progress bar tab ring activity.progress',
    kind: 'boolean',
    setByYou: config.terminalProgressBarEnabled === false || progressPin !== undefined,
    value: progressPin === undefined ? boolValue(progressBarOn) : (
      <Text>
        {boolValue(progressBarOn)}
        <Text color={tokens.textSecondary}> · activity.progress {String(progressPin)} in settings</Text>
      </Text>
    ),
    warning: 'the ring in the terminal tab while a turn runs · activity.progress in settings decides when set (false turns it off, true keeps it on where the terminal allows); otherwise this switch',
    change: () => {
      if (progressPin !== undefined) {
        if (writeSource('userSettings', { activity: { progress: progressPin ? false : undefined } })) {
          recordToggle('terminalProgressBar', `set activity.progress to ${progressPin ? 'false' : 'unset'}`)
          bump()
        }
        return
      }
      writeGlobal(c => ({ ...c, terminalProgressBarEnabled: c.terminalProgressBarEnabled === false }))
      recordToggle('terminalProgressBar', `set terminal progress bar to ${config.terminalProgressBarEnabled === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'turnDuration',
    label: 'Turn duration',
    kind: 'boolean',
    setByYou: config.showTurnDuration === false,
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
    setByYou: merged.guardrails?.mode !== undefined,
    value: sessionModeDiffers ? (
      <Text>
        {permissionModeTitle(defaultMode)}
        <Text color={tokens.textSecondary}> · this session: {permissionModeTitle(sessionMode.mode)}</Text>
      </Text>
    ) : (
      <Text>{permissionModeTitle(defaultMode)}</Text>
    ),
    warning: sessionModeDiffers ? `this session: ${describeSessionPermissionMode(sessionMode)}; the saved switch governs the next boot, never this one` : undefined,
    change: direction => {
      const next = cycleIn(modeOptions, defaultMode, direction)
      if (
        writeSource('userSettings', { guardrails: { mode: next } })
      ) {
        recordSet('defaultPermissionMode', `set default permission mode to ${permissionModeTitle(next)}`)
        bump()
      }
    },
  })
  {
    const pinned = readPinnedStatus()
    const limit = pinnedTextLimit()
    const fill = pinned ? `${formatTextSize(pinned.used)} of ${formatTextSize(limit)}` : `0 of ${formatTextSize(limit)}`
    items.push({
      id: 'memory.pinnedLimit',
      label: 'Pinned memory limit',
      searchText: 'pinned memory limit rules shelf text size',
      kind: 'enum',
      value: <Text color={pinned?.over ? tokens.warning : undefined}>{`${fill}${pinned?.over ? ' · over, all still loaded' : ''}`}</Text>,
      setByYou: merged.memory?.pinnedLimit !== undefined,
      warning: `how much pinned memory text loads into every session before Mercury says the shelf is full (${pinned?.pinned ?? 0} rule${pinned?.pinned === 1 ? '' : 's'} pinned) · every pinned rule still loads past it · ←/→ move the limit by ${formatTextSize(PINNED_TEXT_LIMIT_STEP)} · pin and unpin in /memory`,
      change: direction => {
        const next = Math.max(PINNED_TEXT_LIMIT_MIN, limit + direction * PINNED_TEXT_LIMIT_STEP)
        if (writeSource('userSettings', { memory: { pinnedLimit: next } })) {
          recordSet('memory.pinnedLimit', `set the pinned memory limit to ${formatTextSize(next)}`)
          void runDueMaintenance('operator', { force: true }).finally(() => bump())
        }
      },
    })
    const startLimit = startTextLimit()
    const atStart = memoryAtStartStatus()
    const rodeWords = atStart === null ? '' : ` · this session: ${atStart.rodeFacts} of ${atStart.facts} fact${atStart.facts === 1 ? '' : 's'}${atStart.notes > 0 ? ` and ${atStart.rodeNotes} of ${atStart.notes} earlier note${atStart.notes === 1 ? '' : 's'}` : ''} rode beside the ${atStart.pinnedCount} pinned rule${atStart.pinnedCount === 1 ? '' : 's'}`
    items.push({
      id: 'memory.startLimit',
      label: 'Memory at start, beyond the pins',
      searchText: 'memory at start beyond the pins allowance relevant facts branch files text size',
      kind: 'enum',
      value: <Text>{`${formatTextSize(atStart?.used ?? 0)} of ${formatTextSize(startLimit)}`}</Text>,
      setByYou: merged.memory?.startLimit !== undefined,
      warning: `how much memory text rides at the start of a session beyond the pinned rules, which always ride whole: the facts and earlier notes most relevant to the branch, the files touched lately and the last note${rodeWords} · what is left out is a Recall away · ←/→ move the allowance by ${formatTextSize(START_TEXT_LIMIT_STEP)} · the next session reads it`,
      change: direction => {
        const next = Math.max(START_TEXT_LIMIT_MIN, startLimit + direction * START_TEXT_LIMIT_STEP)
        if (writeSource('userSettings', { memory: { startLimit: next } })) {
          recordSet('memory.startLimit', `set the memory-at-start limit to ${formatTextSize(next)}`)
          bump()
        }
      },
    })
  }
  {
    const embedSpec = typeof merged.memory?.embeddingModel === 'string' ? merged.memory.embeddingModel.trim() : ''
    const embedReadiness = describeSemanticReadiness()
    const embedValue = embedReadiness.state === 'ok' ? embedReadiness.model : WORD_MATCH_ONLY_WORDS
    const servable = servableEmbedModelNames()
    const embedChoices = ['', ...servable.filter(name => name !== EMBED_DEFAULT_MODEL)]
    const choiceWords = servable.length > 1 ? `←/→ picks among the ${servable.length} models this install carries` : 'this install carries one model, the shipped default'
    items.push({
      id: 'memory.embeddingModel',
      label: 'Memory recall ranking',
      searchText: 'memory recall ranking embedding model semantic meaning word match',
      kind: 'enum',
      value: <Text color={embedReadiness.state === 'ok' ? undefined : tokens.textSecondary}>{embedValue}</Text>,
      setByYou: merged.memory?.embeddingModel !== undefined,
      warning: `${embedReadiness.state === 'ok' ? `recall ranks by meaning and words through ${embedValue} — everything stays on this machine` : `recall runs word match only — ${embedReadiness.note}`} · ${choiceWords}`,
      change: direction => {
        const current = embedSpec === '' || embedSpec === 'default' ? '' : embedSpec
        const next = cycleIn(embedChoices, embedChoices.includes(current) ? current : '', direction)
        if (writeSource('userSettings', { memory: { embeddingModel: next === '' ? undefined : next } })) {
          recordSet('memory.embeddingModel', `set the memory recall ranking to ${next === '' ? 'the shipped default' : next}`)
          bump()
        }
      },
    })
  }
  {
    const journalOn = journalSettingOn(merged)
    items.push({
      id: 'memory.journal',
      label: 'Session journal',
      searchText: 'session journal model own words what happened how you like to work',
      kind: 'boolean',
      value: boolValue(journalOn),
      setByYou: merged.memory?.journal !== undefined,
      warning: "off unless you turn it on · at session end the model writes, in its own words, what happened, what you wanted, how you like to work and what it got wrong · a file in the Mercury home beside the project's memory, never under the project tree · Mercury never pushes, syncs or shares it · read it in /memory",
      change: () => {
        if (writeSource('userSettings', { memory: { journal: !journalOn } })) {
          recordToggle('memory.journal', `set the session journal to ${journalOn ? 'off' : 'on'}`)
          bump()
        }
      },
    })
    const onEntryPage = merged.memory?.journalOnEntryPage === true
    items.push({
      id: 'memory.journalOnEntryPage',
      label: 'Journal on the entry page',
      searchText: 'journal entry page session start last entry model reads provider request',
      kind: 'boolean',
      value: boolValue(onEntryPage),
      setByYou: merged.memory?.journalOnEntryPage !== undefined,
      warning: "includes the journal's last entry in the session-start context sent to the model's provider (Mercury never syncs or shares the journal elsewhere)",
      change: () => {
        if (writeSource('userSettings', { memory: { journalOnEntryPage: !onEntryPage } })) {
          recordToggle('memory.journalOnEntryPage', `set the journal on the entry page to ${onEntryPage ? 'off' : 'on'}`)
          bump()
        }
      },
    })
  }
  items.push({
    id: 'files.honourGitignore',
    label: 'Respect .gitignore in file picker',
    kind: 'boolean',
    setByYou: merged.files?.honourGitignore !== undefined,
    value: boolValue(merged.files?.honourGitignore !== false),
    change: () => {
      const next = merged.files?.honourGitignore === false
      if (writeSource('userSettings', { files: { honourGitignore: next } })) {
        recordToggle('files.honourGitignore', `set honour-gitignore to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'theme',
    label: 'Theme',
    kind: 'managed-enum',
    setByYou: themeSetting !== DEFAULT_THEME_SETTING,
    value: <Text>{THEME_LABELS[themeSetting] ?? themeSetting}</Text>,
    open: 'theme',
  })
  items.push({
    id: 'language',
    label: 'Language',
    kind: 'managed-enum',
    setByYou: merged.voice?.language !== undefined,
    value: <Text>{merged.voice?.language ?? 'auto'}</Text>,
    open: 'language',
  })
  items.push({
    id: 'editorMode',
    label: 'Editor mode',
    kind: 'enum',
    setByYou: validated(EDITOR_MODES, config.editorMode, 'normal') !== 'normal',
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
    setByYou: config.prStatusFooterEnabled === false,
    value: boolValue(config.prStatusFooterEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, prStatusFooterEnabled: c.prStatusFooterEnabled === false }))
      recordToggle('prStatusFooter', `set PR status footer to ${config.prStatusFooterEnabled === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'model',
    label: 'Model (main loop)',
    searchText: 'model provider main loop',
    kind: 'info',
    setByYou: merged.engine?.model !== undefined,
    value: (
      <Text>
        {mainLoopPointerText(servedModel ?? appState.engineModelForSession ?? appState.engineModel)}
      </Text>
    ),
  })
  const localMain = mainRoute === 'local' ? localRecordFor(servedModel ?? appState.engineModelForSession ?? appState.engineModel ?? getEngineModel()) : undefined
  const localWindowRow = localModelWindowRow(localMain, mainRoute ?? 'unrecognised', configStamp)
  items.push({
    id: 'localModelWindow',
    label: 'Local model window',
    searchText: 'local model window context num_ctx ollama lm studio served window',
    kind: 'enum',
    value: <Text color={localWindowRow.overFit ? tokens.failureText : localWindowRow.tight ? tokens.warning : localWindowRow.applies ? undefined : tokens.textSecondary} wrap="truncate-end">{localWindowRow.valueText}</Text>,
    setByYou: localWindowRow.setByYou,
    warning: localWindowRow.note,
    change: direction => {
      if (localMain === undefined || !localWindowRow.applies) return
      const next = nextLocalWindowSetting(localWindowSettingOf(localMain), direction)
      writeLocalWindowSetting(localMain, next, writeGlobal)
      recordSet('localModelWindow', `set the local model window for ${localMain.id} to ${localWindowSettingWords(next)}`)
      bump()
    },
  })
  for (const row of configProviderRows(providerFamilyPresences())) {
    items.push({
      id: row.id,
      label: row.label,
      searchText: `${row.label} provider signed in`,
      kind: 'info',
      value: (
        <Text color={row.credentialed ? tokens.success : tokens.textSecondary} wrap="truncate-end">
          {row.valueText}
        </Text>
      ),
    })
  }
  items.push(
    ...localServerConfigItems({
      state: localServer,
      nowMs: Date.now(),
      tokens,
      onSet: (id, value, words) => {
        if (writeSource('userSettings', { local: { server: { [id]: value } } })) {
          recordSet(`localServer.${id}`, words)
          bump()
        }
      },
    }),
  )
  items.push(
    ...advisorConfigItems({
      tokens,
      onToggle: (next, words) => {
        setAdvisorEnabled(next, writeGlobal)
        recordToggle('advisor', words)
        bump()
      },
      onInterval: (next, words) => {
        setAdvisorMinutes(next, writeGlobal)
        recordSet('advisor.minutes', words)
        bump()
      },
    }),
  )

  {
    items.push({
      id: 'fileCheckpointing',
      label: 'File checkpointing',
      kind: 'boolean',
      setByYou: config.fileCheckpointingEnabled === false,
      value: boolValue(config.fileCheckpointingEnabled !== false),
      change: () => {
        writeGlobal(c => ({ ...c, fileCheckpointingEnabled: c.fileCheckpointingEnabled === false }))
        recordToggle('fileCheckpointing', `set file checkpointing to ${config.fileCheckpointingEnabled === false ? 'on' : 'off'}`)
      },
    })
    const facts = getFocusedSessionConnector().checkpointFacts()
    const points = facts.restorable.size
    const sessionText = !hasFocusedSession()
      ? 'no chat open'
      : facts.capture === 'on'
        ? `capturing · ${points} restore point${points === 1 ? '' : 's'}`
        : facts.capture === 'off'
          ? 'not capturing in this session'
          : "not reported — this session started before checkpoint capture (start a new session when ready)"
    items.push({
      id: 'fileCheckpointsSession',
      label: 'Checkpoints in this session',
      searchText: 'checkpoints session rewind restore points capture',
      kind: 'info',
      value: <Text color={facts.capture === 'on' ? tokens.success : tokens.textSecondary}>{sessionText}</Text>,
    })
  }
  if (isFullscreenActive()) {
    items.push({
      id: 'copyOnSelect',
      label: 'Copy on select',
      kind: 'boolean',
      setByYou: config.copyOnSelect === false,
      value: boolValue(config.copyOnSelect !== false),
      change: () => {
        writeGlobal(c => ({ ...c, copyOnSelect: c.copyOnSelect === false }))
        recordToggle('copyOnSelect', `set copy-on-select to ${config.copyOnSelect === false ? 'on' : 'off'}`)
      },
    })
    items.push({
      id: 'mouseCapture',
      label: 'Mouse capture',
      kind: 'boolean',
      setByYou: config.mouseCapture === false,
      value: boolValue(config.mouseCapture !== false),
      change: () => {
        const next = config.mouseCapture === false
        writeGlobal(c => ({ ...c, mouseCapture: next }))
        inkInstances.get(process.stdout)?.setMouseTrackingEnabled(next)
        recordToggle('mouseCapture', `set mouse capture to ${next ? 'on' : 'off'}`)
      },
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

  const agentDefaults = subagentDefaultsOf(config.agents)
  const writeAgents = (patch: Partial<NonNullable<GlobalConfig['agents']>>): void => {
    writeGlobal(c => ({ ...c, agents: { ...c.agents, ...patch } }))
  }
  items.push({
    id: 'agentsDefaultEffort',
    label: 'Crewmate default effort',
    searchText: 'crewmate default effort delegate workflow',
    kind: 'enum',
    setByYou: agentDefaults.effortSource === 'setting',
    value: (
      <Text>
        {agentDefaults.effort}
        {agentDefaults.effortSource === 'convention' ? <Text color={tokens.textSecondary}> (default)</Text> : null}
      </Text>
    ),
    warning: 'Used when a crewmate call names no effort; independent of the lead.',
    change: direction => {
      const next = cycleIn(EFFORT_LEVELS, agentDefaults.effort, direction)
      writeAgents({ defaultEffort: next })
      recordSet('agentsDefaultEffort', `set the crewmate default effort to ${next}`)
    },
  })
  items.push({
    id: 'agentsDefaultModel',
    label: 'Crewmate default model',
    searchText: 'crewmate default model inherit parent',
    kind: 'managed-enum',
    setByYou: agentDefaults.model !== undefined,
    value: (
      <Text>
        {agentDefaults.model === undefined || agentDefaults.model === AGENT_INHERIT_ROW.id ? AGENT_INHERIT_ROW.name : modelChoiceLabel(agentDefaults.model)}
      </Text>
    ),
    warning: 'Used when the call and agent definition name no model. Inherit uses the parent’s model.',
    open: 'agent-model',
  })
  const envFanoutCap = agentFanoutCap()
  items.push({
    id: 'agentsMaxConcurrent',
    label: 'Crewmates at once',
    searchText: 'crewmate crewmates at once concurrent cap fan-out maximum',
    kind: 'enum',
    setByYou: agentDefaults.maxConcurrentSource === 'setting',
    value: (
      <Text>
        {agentDefaults.maxConcurrent}
        {agentDefaults.maxConcurrentSource === 'convention' ? <Text color={tokens.textSecondary}> (default)</Text> : null}
        {envFanoutCap !== null ? (
          <Text color={tokens.textSecondary}> · MERCURY_AGENT_FANOUT_CAP={envFanoutCap} outranks it this boot</Text>
        ) : null}
      </Text>
    ),
    warning: 'Maximum simultaneous crewmates. Workflows have their own limit.',
    change: direction => {
      const next = Math.max(1, agentDefaults.maxConcurrent + direction)
      writeAgents({ maxConcurrent: next })
      recordSet('agentsMaxConcurrent', `set crewmates at once to ${next}`)
    },
  })
  const backgroundLaunchOn = backgroundSessionsLaunchCrewmates()
  items.push({
    id: BACKGROUND_LAUNCH_KEY,
    label: BACKGROUND_LAUNCH_LABEL,
    searchText: 'crewmate workflow backgrounded background session launch delegate workflows-allowed tag visit',
    kind: 'boolean',
    setByYou: backgroundLaunchOn,
    value: <Text color={backgroundLaunchOn ? tokens.success : tokens.textSecondary}>{backgroundLaunchValueWords(backgroundLaunchOn)}</Text>,
    warning: `${BACKGROUND_LAUNCH_SUMMARY} · ${BACKGROUND_LAUNCH_NOTE} · doors: ${BACKGROUND_LAUNCH_DOORS}`,
    change: () => {
      const next = !backgroundLaunchOn
      setBackgroundSessionsLaunchCrewmates(next, writeGlobal)
      recordToggle(BACKGROUND_LAUNCH_KEY, `set ${BACKGROUND_LAUNCH_LABEL.toLowerCase()} to ${backgroundLaunchValueWords(next)}`)
      bump()
    },
  })

  items.push(...media.items)
  const [searchMode, setSearchMode] = useState(false)
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
  }, [query, version, appState, themeSetting, seatFacts, configStamp, servedModel, jevStamp, localServer.stamp, media.settings, media.catalogue, media.config, media.error])

  const line = configPopupLine(configPopupFolder(), items.length, items.filter(item => item.setByYou === true).length)
  useLayoutEffect(() => {
    onLine?.(line)
  }, [line, onLine])

  const searchRowUp = !compact || searchMode || query !== ''
  const listRows = Math.max(1, contentHeight - (compact ? (searchRowUp ? 1 : 0) : CONFIG_LIST_CHROME_ROWS))
  const windowFor = (index: number): number => {
    const warning = searchMode || compact ? undefined : filtered[index]?.warning
    if (warning === undefined) return listRows
    const beside = Math.max(1, listRows - configWarningRows(warning, width - 1))
    return filtered.length > beside ? beside : Math.max(1, listRows - configWarningRows(warning, width))
  }
  const win = configListWindow(selected, offset, filtered.length, windowFor(Math.max(0, Math.min(selected, filtered.length - 1))))
  useEffect(() => {
    if (win.sel !== selected) setSelected(win.sel)
    if (win.off !== offset) setOffset(win.off)
  }, [win.sel, win.off, selected, offset])
  usePopupMarker(compact && subMenu === null && filtered.length > 0 ? settingsPopupMarker(win.sel + 1, filtered.length) : null)

  const moveTo = (next: number): void => {
    const target = Math.max(0, Math.min(next, filtered.length - 1))
    const fixed = configListWindow(target, offset, filtered.length, windowFor(target))
    setSelected(fixed.sel)
    setOffset(fixed.off)
    setThinkingWarning(false)
  }
  usePopupListPaging(win.sel, filtered.length, windowFor(win.sel), moveTo, subMenu === null)

  const composeSummary = (): string | undefined => {
    const lines: string[] = [...changesRef.current.values()]
    if (themeSetting !== mountTheme.current) lines.push(`set theme to ${themeSetting}`)
    if (lines.length === 0) return undefined
    return lines.join('\n')
  }

  const mediaSaving = useRef(false)
  const saveAndClose = (): void => {
    if (mediaSaving.current) return
    mediaSaving.current = true
    void media.save().then(async reconnect => {
      if (reconnect) {
        const pending = reloadExtensions({ onServersChanged: () => setAppState(prev => ({ ...prev, mcp: { ...prev.mcp, extensionReconnectKey: prev.mcp.extensionReconnectKey + 1 } })) })
        noteReloaded(pending)
        const result = await pending
        setAppState(prev => ({ ...prev, extensions: extensionsStateFrom(result.set, false, null) }))
      }
      onClose(composeSummary())
    }).catch(error => writeFailed('userSettings', error instanceof Error ? error : new Error(String(error)))).finally(() => { mediaSaving.current = false })
  }

  const signInFromDoor = (): void => {
    setSubMenu(null)
    requestCommandDispatch('/logins')
    onClose([composeSummary(), 'Sign in first — /logins opens; the door lists that family once a credential connects'].filter(Boolean).join('\n'))
  }

  const revert = (): boolean => {
    media.revert()
    while (undoRef.current.length > 0) {
      const undo = undoRef.current.at(-1)!
      if (undo.source === 'global') {
        saveGlobalConfig(current => restoreConfigLeaf(current, undo.path, undo.previous) as GlobalConfig)
        if (undo.path[0] === 'motion') noteMotionSettingChanged()
        if (undo.path[0] === 'mouseCapture') inkInstances.get(process.stdout)?.setMouseTrackingEnabled(undo.previous !== false)
      } else if (undo.source === 'app') {
        setAppState(prev => ({ ...prev, verbose: undo.previous as boolean }))
      } else {
        const partial = undo.path.reduceRight<unknown>((value, key) => ({ [key]: value }), undo.previous) as Partial<SettingsJson>
        const { error } = updateSettingsForSource(undo.source, partial)
        if (error !== null) {
          writeFailed(undo.source, error)
          bump()
          return false
        }
        if (undo.path[0] === 'view' && undo.path[1] === 'zen') settingsChangeDetector.notifyChange(undo.source)
        if (undo.path[0] === 'briefs' && undo.path[1] === 'profile') {
          const restoredProfile = getInitialSettings().briefs?.profile
          setSessionInstructionProfile(isInstructionProfile(restoredProfile) ? restoredProfile : null)
          clearInstructionFileCaches()
        }
        if (undo.path[0] === 'shell' && undo.path[1] === 'engine') {
          resetShellEngineResolution()
          void endEngineSession()
        }
      }
      undoRef.current.pop()
    }
    changesRef.current.clear()
    dirtyRef.current = false
    setThinkingWarning(false)
    bump()
    return true
  }

  const escape = (): void => {
    if (mediaSaving.current) return
    if (escapeFromOutsidePress()) {
      if ((dirtyRef.current || media.dirty) && !revert()) return
      onClose(undefined)
      return
    }
    if (searchMode && query !== '') {
      setQuery('')
      return
    }
    if (searchMode) setSearchMode(false)
    if ((dirtyRef.current || media.dirty)) {
      revert()
      return
    }
    onClose(undefined)
  }

  const activate = (index: number): void => {
    const item = filtered[index]
    if (item === undefined) return
    if (item.kind === 'managed-enum' && item.open !== undefined) setSubMenu(item.open)
    else item.change?.(1)
  }

  useInput(
    (input, key, event) => {
      if (subMenu !== null) return
      if (key.escape) {
        event.stopImmediatePropagation()
        escape()
        return
      }
      if (searchMode) {
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
          if (!pastOpenEvent()) return
          setQuery(q => q + input)
        }
        return
      }
      const item = filtered[selected]
      if (key.return) {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
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
        if (!pastOpenEvent()) return
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
        if (!pastOpenEvent()) return
        activate(selected)
        return
      }
      if (input === '/') {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        setSearchMode(true)
        return
      }
      if (
        input !== '' &&
        !key.ctrl &&
        !key.meta &&
        input >= ' ' &&
        input !== ' ' &&
        input.charCodeAt(0) !== 0x7f
      ) {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        setSearchMode(true)
        setQuery(input)
        return
      }
    },
    { isActive: subMenu === null },
  )

  if (subMenu === 'media-root' || subMenu === 'media-image' || subMenu === 'media-video') return <MediaConfigPicker key={subMenu} menu={subMenu} media={media} rows={contentHeight} width={width} onClose={() => setSubMenu(null)} />
  if (subMenu === 'theme') {
    return (
      <Select
        {...(compact ? { visibleOptionCount: Math.max(1, contentHeight) } : {})}
        options={REACHABLE_THEME_SETTINGS.map(setting => ({
          label: THEME_LABELS[setting] ?? setting,
          value: setting,
        }))}
        defaultValue={themeSetting}
        defaultFocusValue={themeSetting}
        onChange={value => {
          setThemeSetting(value)
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'agent-model') {
    return (
      <ModalContext.Provider value={{ rows: contentHeight, columns: width, scrollRef: null }}>
      <MercuryModelChoicePicker
        leading={[AGENT_INHERIT_ROW]}
        current={agentDefaults.model === undefined || agentDefaults.model === AGENT_INHERIT_ROW.id ? AGENT_INHERIT_ROW.id : modelChoiceRow(agentDefaults.model)}
        onSelect={id => {
          const next = id === AGENT_INHERIT_ROW.id ? undefined : parseUserSpecifiedModel(id)
          writeAgents({ defaultModel: next })
          recordSet('agentsDefaultModel', `set the crewmate default model to ${next === undefined ? AGENT_INHERIT_ROW.name : modelChoiceLabel(next)}`)
          setSubMenu(null)
        }}
        onSignIn={signInFromDoor}
        onClose={() => setSubMenu(null)}
      />
      </ModalContext.Provider>
    )
  }
  if (subMenu === 'language') {
    return (
      <LanguagePicker
        initialLanguage={merged.voice?.language}
        onComplete={language => {
          if (writeSource('userSettings', { voice: { language: language } })) {
            recordSet('language', `set language to ${language ?? 'auto'}`)
          }
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'external-includes') {
    return (
      <ExternalInstructionIncludesDialog
        isStandaloneDialog={false}
        externalIncludes={externalIncludes}
        onDone={() => {
          setSubMenu(null)
        }}
      />
    )
  }
  if (subMenu === LOCAL_SERVER_APPLY_MENU && localServer.plan !== null) {
    return (
      <LocalServerApplyDialog
        plan={localServer.plan}
        width={width}
        rows={contentHeight}
        onDone={() => setSubMenu(null)}
        onApplied={outcome => {
          if (outcome.outcome === 'applied') recordSet('localServer.apply', `applied the local server knobs (${outcome.restarted ? 'server restarted' : 'restart pending'})`)
        }}
      />
    )
  }

  const visible = filtered.slice(win.off, win.off + windowFor(win.sel))
  const band = width + 2 - (win.off > 0 || win.hiddenBelow > 0 ? 1 : 0)

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box height={searchRowUp ? 1 : 0} overflow="hidden">
        <SearchBox
          query={query}
          isFocused={searchMode}
          isTerminalFocused={true}
          cursorOffset={query.length}
          placeholder={CONFIG_SEARCH_PLACEHOLDER}
          borderless={true}
        />
      </Box>
      <Box height={compact ? 0 : 1} />
      <PopupListViewport above={win.off} below={win.hiddenBelow} rows={visible.length}>
      {visible.map((item, index) => {
        const at = win.off + index
        const isSelected = !searchMode && at === win.sel
        return (
          <Box key={item.id} flexDirection="column" flexShrink={0}>
            <Box width={band} marginLeft={-1} marginRight={-1} flexShrink={0}>
              <InteractiveRow
                id={`config:row:${item.id}`}
                selected={isSelected}
                onSelect={() => {
                  setSearchMode(false)
                  moveTo(at)
                }}
                onActivate={() => activate(at)}
                width={band}
                height={1}
                flexShrink={0}
              >
                <Box width={1} flexShrink={0} />
                <Box width={LABEL_CELLS} flexShrink={0}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? tokens.textPrimary : tokens.textSecondary}
                    wrap="truncate-end"
                  >
                    {isSelected ? `${CONFIG_ROW_MARK} ` : '  '}
                    {item.label}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
                  {item.value}
                </Box>
                <Box width={1} flexShrink={0} />
              </InteractiveRow>
            </Box>
            {isSelected && !compact && item.warning !== undefined ? (
              <Text color={tokens.warning}>{'  '}{item.warning}</Text>
            ) : null}
          </Box>
        )
      })}
      </PopupListViewport>
      {filtered.length === 0 ? (
        <Box height={1}>
          <Text color={tokens.textMuted}>no settings match “{query}”</Text>
        </Box>
      ) : null}
      <Box height={compact ? 0 : 1} overflow="hidden">
        <Text color={tokens.textMuted}>{configMoreRow(win.hiddenBelow)}</Text>
      </Box>
    </Box>
  )
}
