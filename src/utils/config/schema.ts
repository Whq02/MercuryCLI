// ============================================================================
//  src/utils/config/schema.ts — the global-config shape: types, defaults, and
//  key registries. Leaf module — no io, no state; the io/state cluster is
//  globalConfig.ts and the barrel is config.ts (submodules never import it).
//
//  Persistence contract: every field name below is a KEY IN THE OPERATOR'S
//  CONFIG FILE. Renaming one orphans real state on real machines — retired
//  spellings get an explicit read-time migration (globalConfig.ts
//  migrateConfigFields) or a documented LEGACY hold, never a silent rename.
//  Defaults live in createDefaultGlobalConfig(); the save path persists only
//  non-default values, so a field whose default changes retroactively changes
//  what an absent key means — treat default edits as behaviour changes.
// ============================================================================
import type { McpServerConfig } from '../../services/mcp/types.js'
import type { BillingType } from '../../services/oauth/types.js'
import type { ImageDimensions } from '../imageResizer.js'
import type { ModelOption } from '../model/modelOptions.js'
// The default appearance comes from its leaf owner (systemTheme.ts), never
// from theme.ts: DEFAULT_GLOBAL_CONFIG is minted while this module
// evaluates, and theme.ts pulls the palette and accent graph.
import { DEFAULT_THEME_SETTING } from '../systemTheme.js'
import type { ThemeSetting } from '../theme.js'

// One pasted item in the composer's attachment slots. Text pastes carry the
// text; image pastes carry base64 content plus enough metadata to render the
// chip and map click coordinates back onto the original bitmap.
export type PastedContent = {
  id: number // sequential per composer session; the slot's stable key
  type: 'text' | 'image'
  content: string
  mediaType?: string // image MIME, e.g. 'image/png'
  filename?: string // chip label for images
  dimensions?: ImageDimensions // set only when the paste was resized (coordinate mapping)
  sourcePath?: string // original path when the image was dragged from disk
}

// history.jsonl entry as stored on disk: pastes are optional there, and very
// large pasted text may be held as one string instead of the slot record.
export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
// The in-memory prompt-history entry: pastes always materialized.
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  // "last session" summary figures, written at exit and read by the next
  // boot's header/status surfaces. The two *Window records below label the
  // measurement windows these figures were taken over.
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  /** the permission-posture record — written at the boot decision so
   *  a fresh read of the config alone names the REAL composition (the audit
   *  had to cross-reference the env row, the settings suppression, and the
   *  never-shown trust dialog across three files). */
  permissionPosture?: {
    mode: 'bypass' | 'standard'
    /** Present when mode==='bypass': what armed it. */
    armedBy?: 'env-standing-consent' | 'cli-flag' | 'session-choice'
    consentDialog: 'shown-accepted' | 'suppressed-by-standing-consent' | 'not-required'
    trustDialogAccepted: boolean
    recordedAtMs: number
  }
  /** the accounting WINDOW the lastCost/lastDuration/token family was
   *  measured over — the cost tracker's session window (restored across
   *  --resume when the session id matches). Labeled so a reader never mixes
   *  it with the frame-metrics window below. */
  lastCostWindow?: {
    kind: 'session-cumulative'
    sessionId?: string
    savedAtMs: number
  }
  /** the window lastSessionMetrics/FPS figures were measured over —
   *  ONE process leg (a resumed session's counters restart at 0), which is
   *  NOT the cost family's window. The field audit found 68,816 lifetime
   *  frames beside a 10.6s final-leg duration in one unlabeled block. */
  lastSessionMetricsWindow?: {
    kind: 'process-leg'
    pid: number
    savedAtMs: number
  }
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  /** Per model, the settled turns of the same window whose USD was never
   *  recorded (no rate on file) — restored with the cost family so a
   *  resumed session keeps saying "unpriced" instead of a zero that reads
   *  as free. */
  lastUnpricedTurns?: Record<string, number>
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // Trust: accepting the dialog for a directory persists here (keyed by the
  // project path) and covers every child directory — trust.ts walks
  // ancestors on read.
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  // External @include approval for instruction files: approved lets
  // discovery compose content from outside the project; WarningShown makes
  // the ask one-shot either way.
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // Per-project .mcp.json approval state. The enable/disable pair predates
  // the settings-based approval flow and is still honored on read.
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // The /mcp enable-disable toggle's off-list, across all scopes.
  disabledMcpServers?: string[]
  // Opt-in list for built-in MCP servers that ship default-off.
  enabledMcpServers?: string[]
  /** THE MENU STORE's skills half (the "MCPs & Skills" boot menu — the NEXT
   *  session's default kit, per repo; L24(3)/(5)): opt-out DELTAS keyed by
   *  the skill's resolved name — absent = on (ambient), 'invocable' = the
   *  /name door only (never ambient), 'off' = absent from the born session.
   *  Deltas, never a roster: an empty record is today's behaviour and a
   *  newly installed skill is on with no migration. The MCP half is the
   *  disabledMcpServers/enabledMcpServers pair above, reused as-is. Read
   *  and written by explicit workspace (services/mcp/kitStore.ts). */
  skillStates?: Record<string, 'off' | 'invocable'>
  /** The menu's per-extension MASTER ROWS (the operator's option 2): 'off'
   *  = nothing the extension contributes — skills, servers, commands, hooks
   *  — loads in the born session; absent = on. Keyed by the extension's
   *  manifest name (the `ext:<name>:` spelling). Distinct from the
   *  extensions estate's own install-level contribution switches, which
   *  keep their own door; the two AND at the runner. */
  extensionStates?: Record<string, 'off'>
  // The active worktree session (mercury -w): enough to land the operator
  // back where they started when the session ends.
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** Multi-session spawn preference for remote control: new sessions open in
   *  the project dir or a fresh worktree. Set by the first-run dialog or the
   *  `w` toggle. */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from '../configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from '../configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

// The signed-in account, as the OAuth profile endpoint reports it. Org/role
// fields are nullable because older grants predate them — absent means
// "profile never reported it", not "no org".
export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null
  organizationRole?: string | null
  workspaceRole?: string | null
  displayName?: string
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

// 'emacs' is a retired spelling some configs still carry; it reads as the
// modern default. Drop the union arm only with a read-time migration.
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type GlobalConfig = {
  /**
   * @deprecated — settings.apiKeyHelper owns this now; read-only compat.
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  // Count of interactive boots on this machine (tips cadence, onboarding
  // pacing key off it). Headless boots count separately below.
  numStartups: number
  /** .5.4: bounded headless-activity counters — print/
   *  sdk boots + CLI verbs with last-activity stamps. numStartups stays
   *  interactive-only; wedge detection reads BOTH. */
  headlessActivity?: {
    print: number
    sdk: number
    verbs: Record<string, number>
    lastKind: string
    lastAt: number
  }
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // True when the updater itself disabled autoUpdates to protect a native
  // install — distinguishes that from the operator's own preference.
  autoUpdatesProtectedForNative?: boolean
  // numStartups value at the last health-report prompt (cadence anchor).
  doctorShownAtSession?: number
  // The durable harness-profile operator pin (a HarnessProfile
  // id; qualified/accepted only — the resolver declines anything else with a
  // NAMED reason, never a silent substitute). Read only while
  // MERCURY_HARNESS_PROFILE is armed.
  harnessProfilePin?: string
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // The version whose install last reset onboarding (compared against
  // MIN_VERSION_REQUIRING_ONBOARDING_RESET to decide a re-run).
  lastOnboardingVersion?: string
  // The version whose release notes were last shown.
  lastReleaseNotesSeen?: string
  // Changelog fetch bookkeeping: the fetch timestamp lives here, the content
  // lives in the home cache dir (cache/changelog.md).
  changelogLastFetched?: number
  // @deprecated — content moved to the home cache dir; read for migration only.
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  /** THE PRESET STORE (ledger L24(4) + the operator's both-doors
   *  ruling): named kit snapshots — each value is EXACTLY the
   *  menu store's rendered deltas shape (KitDeltasV1, services/mcp/
   *  kitStore.ts; the spelling here is structural because this module
   *  cannot import services/*, and presetStore.ts pins the two equal by
   *  type identity). Deviations-only, absent = on: a preset of an all-on
   *  menu is EMPTY deltas, lawful. GLOBAL BY DESIGN (the ruled store
   *  home): a preset travels across repos; the member names inside are
   *  per-repo spellings, so a delta naming a member a repo lacks simply
   *  does not bite there (absent = on stands) and the resolve receipt
   *  names it. Written only by the presetStore pens (the kit screen's
   *  save prompt and presets layer); read by the screen's wear door and
   *  the daemon's preset derivation. Absent field = no presets saved —
   *  never healed to an empty map. "pack" is the extensions estate's
   *  word — a saved kit snapshot is a PRESET. */
  kitPresets?: Record<string, { mcpOff: string[]; skillStates: Record<string, 'off' | 'invocable'>; extensionsOff: string[] }>
  // Hosted MCP connectors that have connected successfully at least once.
  // Gates the "connector unavailable / needs auth" boot notices: a connector
  // the operator has actually used deserves a flag when it breaks; an
  // org-pushed connector that has been needs-auth since day one has been
  // demonstrably ignored and must not nag.
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /** the per-user HOST-signal policy (the layer ABOVE the
   *  notifier; in-app attention is independent and never gated here).
   *  Absent field/keys ride the documented defaults: needs-you ON,
   *  ready-to-review ON, settled (completed/failed, coalesced) ON,
   *  started OFF (in-app always, host opt-in), detailedPreview OFF (no
   *  private prompt content in host notifications unless explicitly on). */
  concourseHostSignals?: {
    started?: boolean
    needsYou?: boolean
    readyToReview?: boolean
    settled?: boolean
    detailedPreview?: boolean
  }
  /** the Concourse coordinator mode. Default
   *  rules-only (the deterministic kernel, zero model calls); 'off' stands
   *  the kernel down (sessions stay fully valid — operator parity);
   *  'agent-assisted' resolves through the ONE mode owner
   *  (resolveCoordinatorMode) as itself; whether the lane may take a model
   *  turn is the separate composition (resolveEffectiveCoordinator —
   *  registry validation + route honesty, downgrading TYPED). */
  concourseCoordinator?: {
    mode?: 'off' | 'rules-only' | 'agent-assisted'
    /** The chosen assist model — validated against the COMPOSED registry at
     *  every read (coordinatorModels.validateCoordinatorModelChoice); an
     *  invalid/refused choice surfaces its typed reason and is never
     *  silently substituted. */
    assistModel?: string
    /** The coordinator model's own persistent effort (the e doorway in the
     *  coordinator-model picker) — a shared-ladder level its engine turns
     *  actually carry. Written only through
     *  coordinatorModels.switchCoordinatorEffort (normalized + typed
     *  refusal); read through resolveCoordinatorEffort, which answers
     *  undefined for an off-ladder stored spelling — never a guess. Absent
     *  ⇒ the model's own default resolution applies. */
    effort?: string
  }
  /** The run-completion supervisor toggle (/supervisor); default off. */
  supervisorEnabled?: boolean
  /** The PINGS bell (/pings): the one terminal-bell tap when a session
   *  raises a need or finishes a run. Absent = ON (the default);
   *  false withholds the beep only — the rows stay either way. Owner:
   *  services/pings/pingEngine.ts (read live at tap time, never cached). */
  pingsBell?: boolean
  /** The two SUB-model containers' saved picks (Minerva · Console), one
   *  optional canonical model id each. Owner:
   *  utils/model/subModelSlots.ts — written only through setSubModel
   *  (validated against the live catalogue; a refused pick never lands),
   *  read under the env-pin > saved > UNSET ladder (an absent pick is an
   *  unset container that answers the /submodels hint; no default derives). */
  subModels?: {
    minerva?: string
    console?: string
    /** Each container's own persistent effort (the e dial on a /submodels
     *  row): a level of the one effort ladder, keyed by container. Written
     *  only through subModelSlots.setSubModelEffort (normalized; a typed
     *  refusal names the ladder); read through resolveSubModelEffort, which
     *  answers undefined for an off-ladder stored spelling — never a guess.
     *  Absent ⇒ the pinned model's own default. Independent of the model
     *  pick: it survives a model change and rides the wire wherever the
     *  pinned model offers the level; where it does not, the dispatch
     *  composer sends no level (the model default) and says so. */
    effort?: {
      minerva?: string
      console?: string
    }
  }
  /** (the brief's seats law): the one-time first-boot
   *  capacity decision — asked once, never again; declining stores
   *  allowed:false and no number (the machine's live reading is the cap).
   *  Owner:
   *  services/switchboard/capacityCheck.ts (needsCapacityAsk /
   *  recordCapacityDecision / resolveSeatCeiling). */
  switchboardCapacity?: {
    askedAt: number
    allowed: boolean
    /** Stored by a CONSENTED probe, honoured as-is; a declined probe
     *  stores none and the ceiling reads the machine live. */
    recommendedSeats?: number
  }
  /** the coordinator-off composer hint already painted
   *  once (durable here because the coordinator conversation is capped and
   *  can evict the hint entry; the marker must survive that). */
  hasSeenCoordinatorOffHint?: boolean
  /** 3.5.8: the response-length profile — ONE balanced default
   *  plus the concise override (the prompt contract appends its single
   *  override sentence when set). Never a knob wall. */
  responseProfile?: 'balanced' | 'concise'
  /**
   * @deprecated — the Notification hook (docs/hooks.md) replaced this.
   */
  customNotifyCommand?: string
  verbose: boolean
  // Verdicts on manually entered API keys, keyed by truncated key — so an
  // approved key is not re-confirmed and a rejected one is not re-offered.
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  // The OAuth-provisioned API key used when no environment key is set. The
  // name understates it (it holds the oauth-created key specifically); it is
  // a persisted key, so it keeps its spelling.
  primaryApiKey?: string
  hasAcknowledgedCostThreshold?: boolean
  hasResetAutoModeOptInForDefaultOffer?: boolean // one-shot migration guard, re-prompts churned auto-mode users
  oauthAccount?: AccountInfo
  /** The Anthropic ACTIVE-slot preference (the family's
   *  two-slot switch): 'api-key' seats the /logins managed key as the
   *  wire's credential while the claude.ai sign-in stays stored, signed in
   *  and background-refreshed; absent or 'subscription' keeps the
   *  subscription-first precedence byte-identical. Honored ONLY while the
   *  managed key actually resolves — with the key removed, the subscription
   *  quietly resumes the seat and every gauge repaints from the doors
   *  (never a credential-less refusal). Read at the ONE resolution door
   *  (utils/auth getAuthTokenSource + isClaudeAISubscriber); written by the
   *  slot-switch owner only. */
  anthropicPreferredSource?: 'subscription' | 'api-key'
  iterm2KeyBindingInstalled?: boolean // retired installer's marker; read-only compatibility
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean
  // Settings rung of resolveAutoCompactWindow() precedence
  // (settings.autoCompactWindow > model default).
  // Optional: undefined leaves the model-default window in effect.
  autoCompactWindow?: number
  showTurnDuration: boolean // the per-turn duration line at turn end
  /**
   * @deprecated — settings.env owns this now; read-only compat.
   */
  env: { [key: string]: string }
  hasSeenTasksHint?: boolean
  // Whether the one-shot "auto is now the default permission mode" first-run
  // notice has been shown (set after shouldShowAutoDefaultNotice fires).
  hasSeenAutoDefaultNotice?: boolean
  // Whether the one-shot "make auto your default permission mode?" nudge has
  // been shown/resolved (set after shouldShowAutoDefaultNudge fires).
  hasSeenAutoDefaultNudge?: boolean
  hasUsedStash?: boolean // Ctrl+S stash used at least once (gates its hint)
  hasUsedBackgroundTask?: boolean // Ctrl+B background used at least once (gates its hint)
  /** The task/teammate panel the operator last left open — restored at the
   *  next boot and resume (sweep #2, packet 61). */
  expandedView?: 'none' | 'tasks' | 'teammates'
  diffTool?: DiffTool
  // One-time terminal-setup state: backups taken before Mercury edits
  // terminal preferences, and in-progress markers so an interrupted setup
  // can be detected and rolled back.
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string
  appleTerminalBackupPath?: string
  appleTerminalSetupInProgress?: boolean

  // Keybinding installs (one-time setup marks).
  shiftEnterKeyBindingInstalled?: boolean // iTerm2/VS Code Shift+Enter
  optionAsMetaKeyInstalled?: boolean // Terminal.app Option-as-Meta

  // IDE integration preferences.
  autoConnectIde?: boolean // connect automatically when exactly one valid IDE is present
  autoInstallIdeExtension?: boolean // install the extension when running inside an IDE

  // IDE dialog one-shots.
  hasIdeOnboardingBeenShown?: Record<string, boolean> // keyed by terminal name
  ideHintShownCount?: number // showings of the /ide hint
  hasIdeAutoConnectDialogBeenShown?: boolean

  tipsHistory: {
    [tipId: string]: number // numStartups at the tip's last showing
  }

  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // "Don't ask again" on the transcript-share prompt.
  transcriptShareDismissed?: boolean

  // Mercury — the persisted /companion toggle (the session companion:
  // soul + mood poses + speech bubble; explicit MERCURY_DECK_COMPANION env
  // still wins at read time). Saved via the /companion command.
  companionEnabled?: boolean
  // Mercury — the LEGACY default-provider record. The default provider is
  // now the provider of the MOST RECENT SIGN-IN (the neutral-default
  // ruling: utils/model/computedDefault over the sign-in
  // ledger; /defaultprovider records an operator switch in that ledger).
  // This field — written by the first login and by /defaultprovider before
  // the ledger existed — has NO writer any more and is read only as the
  // tiebreak among credentials whose sign-in time was never recorded (a
  // home keeps its lane until its next sign-in). Set, never heal-repainted:
  // no read path writes it back; an unknown stored value reads as unset,
  // the stored bytes untouched. Values are router family ids.
  defaultProvider?: string
  // Mercury — THE CONCOURSE SWITCH (the operator's
  // word): `mercury --concourse-off` (the banked
  // spelling `-concourse-off` admits too) turns the concourse machinery off
  // for this and every future bare boot; `--concourse-on` / the /config row
  // turn it back on. DEFAULT ON — absent reads as on. SET, never
  // heal-repainted: the boot switch and the /config row are the only
  // writers; no read path writes it back. Read through
  // services/concourse/concourseEnabled.ts (the one reader).
  concourseEnabled?: boolean
  // Mercury — the persisted /critter session-theme default (a CRITTERS key,
  // e.g. 'crab' | 'octopus' | 'jellyfish' | 'clam'; a retired spelling in a
  // saved file resolves at READ via LEGACY_CRITTER_KEYS — the stored value
  // is never rewritten). Saved via the /critter
  // picker's `s` (set-default) key; resolveInitialKey() seeds the session accent
  // from it when MERCURY_CRITTER is unset. Mercury-only; a bare stamp never writes it.
  defaultCritter?: string

  memoryUsageCount: number // times the operator has added to memory (# shortcut)

  // Sonnet-1M rollout state, all keyed per org: welcome one-shots plus the
  // cached access checks (subscriber and pay-as-you-go separately). The
  // hasAccess key means "has access as the default model" — the historical
  // spelling is kept because it is persisted; hasAccessNotAsDefault carries
  // the non-default grant.
  hasShownS1MWelcomeV2?: Record<string, boolean>
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >

  // Voice-mode notice cadence. The language-hint pair resets its count when
  // the resolved STT language changes (a new language re-earns the hint).
  voiceNoticeSeenCount?: number
  voiceLangHintShownCount?: number
  voiceLangHintLastLanguage?: string
  voiceFooterHintSeenCount?: number

  opus1mMergeNoticeSeenCount?: number // opus-1m-merge notice showings

  // Experiment enrollment notices, keyed by experiment id.
  experimentNoticesSeenCount?: Record<string, number>

  // OpusPlan welcome one-shot, per org.
  hasShownOpusPlanWelcome?: Record<string, boolean>

  promptQueueUseCount: number // times the prompt queue has been used

  // LEGACY (there is no /btw command; the Helm console owns
  // side questions) — retained so existing configs stay valid.
  btwUseCount: number

  lastPlanModeUse?: number // timestamp of the last strategy-mode use

  // Subscription notice/upsell cadence + cached availability.
  subscriptionNoticeCount?: number
  hasAvailableSubscription?: boolean
  subscriptionUpsellShownCount?: number // deprecated counter; read-only

  todoFeatureEnabled: boolean
  showExpandedTodos?: boolean // render todos expanded even when empty
  showSpinnerTree?: boolean // teammate spinner tree instead of pills

  firstStartTime?: string // ISO timestamp of Mercury's first start on this machine

  // Idle threshold before the "done generating" notification fires (ms).
  messageIdleNotifThresholdMs: number

  githubActionSetupCount?: number
  slackAppInstallCount?: number

  fileCheckpointingEnabled: boolean

  // Terminal progress bar (OSC 9;4).
  terminalProgressBarEnabled: boolean

  // Terminal-tab status indicator (OSC 21337): when on, the tab sidebar
  // gets a colored dot + status text, and the title loses its spinner
  // prefix — the dot already says "working".
  showStatusInTerminalTab?: boolean

  // Push-notification toggles, set via /config. All default off — each is
  // an explicit opt-in.
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  // Effort callout one-shots. v1 is legacy but still read: a Pro operator
  // who dismissed v1 must not be re-shown v2.
  effortCalloutDismissed?: boolean
  effortCalloutV2Dismissed?: boolean

  // One-shot dialog before the first bridge enable.
  remoteDialogSeen?: boolean

  // Cross-process backoff for initReplBridge's oauth_expired_unrefreshable
  // skip. `expiresAt` dedups by content: it names the dead token, and
  // /logins replacing the token clears the backoff for free. `failCount`
  // bounds false positives — a transient refresh failure (auth-server 5xx,
  // lock error) gets 3 tries before the backoff arms, the same ceiling
  // useReplBridge's MAX_CONSECUTIVE_INIT_FAILURES uses. Net effect: a
  // dead-token account costs at most 3 config writes; a healthy account
  // with a transient blip self-heals in roughly 210s.
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  // Desktop upsell startup dialog cadence.
  desktopUpsellSeenCount?: number // total showings (max 3)
  desktopUpsellDismissed?: boolean // "Don't ask again" picked

  // Idle-return dialog.
  idleReturnDismissed?: boolean // "Don't ask again" picked

  // Model-migration one-shots: each records that the corresponding default
  // switch already announced itself, so the notice never repeats.
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number
  sonnet1m45MigrationComplete?: boolean
  legacyOpusMigrationTimestamp?: number
  sonnet45To46MigrationTimestamp?: number

  // Last emergency tip shown (prevents an immediate repeat).
  lastShownEmergencyTip?: string

  // File picker: honor .gitignore (default true). .ignore files are always
  // honored regardless.
  respectGitignore: boolean

  // /copy behavior: always copy the full response instead of opening the picker.
  copyFullResponse: boolean

  // Fullscreen drag-selection auto-copy on mouse-up (OSC 52 + native pbcopy).
  // Default ON — drag-release copies, the cmd+c muscle-memory path on macOS;
  // explicit false opts out.
  copyOnSelect?: boolean

  // Teleport directory switching: "owner/repo" (lowercase) → absolute paths
  // where that repo is cloned on this machine.
  githubRepoPaths?: Record<string, string[]>

  // Terminal emulator for mercury:// deep links. Captured from TERM_PROGRAM
  // during interactive sessions because the deep-link handler itself runs
  // headless (LaunchServices/xdg) with no TERM_PROGRAM in its env.
  deepLinkTerminal?: string

  // iTerm2 it2 CLI setup.
  iterm2It2SetupComplete?: boolean
  preferTmuxOverIterm2?: boolean // always use tmux over iTerm2 split panes

  // Skill usage, feeding autocomplete ranking.
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>

  lspRecommendationDisabled?: boolean
  lspRecommendationIgnoredCount?: number // stops recommending after 5 ignores

  // Small-model-generated explanations on permission requests (default on).
  permissionExplainerEnabled?: boolean

  // Teammate spawning: how teammates are hosted (default 'auto').
  teammateMode?: 'auto' | 'tmux' | 'in-process'
  // The model new teammates get when the tool call names none: undefined
  // rides the historical hardcoded Opus, null inherits the leader's model,
  // a string is an explicit alias/id.
  teammateDefaultModel?: string | null

  // PR review status in the footer (default on; feature-gate can override).
  prStatusFooterEnabled?: boolean

  // Voice input (/speak on|off): space in an empty composer captures the
  // microphone and the transcript lands in the composer. Default off.
  voiceInputEnabled?: boolean

  // Epoch ms of the last background refresh pass (quota, passes, client
  // data). Throttled via mercury_cicada_nap_ms.
  startupPrefetchedAt?: number

  // Start Remote Control at boot (BRIDGE_MODE required). undefined defers
  // to the default — getRemoteControlAtStartup() owns the precedence.
  remoteControlAtStartup?: boolean

  // Server-side experiment client data, fetched during bootstrap.
  clientDataCache?: Record<string, unknown> | null

  // Launch-effort unpin flags. New models (Opus 4.7/4.8, Fable 5, Fable 5.1) ship
  // pinned to a launch-default effort until the user touches effort once; touching
  // effort sets the per-family unpin flag so the user's real choice takes over. A
  // bare stamp stores these in the server-pushed `client_data`; Mercury persists
  // them locally here (honest local state, never cloud-coupled). See utils/effort.ts.
  launchEffortUnpins?: {
    opus47?: boolean
    opus48?: boolean
    fable5?: boolean
    fable51?: boolean
  }

  // Extra model-picker options, fetched during bootstrap.
  additionalModelOptionsCache?: ModelOption[]

  // The operator-named OpenAI-compatible endpoint slot:
  // base URL + display label + the operator's model ids (bare
  // vendor ids — Mercury addresses them as compat/<id>). The registered
  // MERCURY_COMPAT_* env flags override each field (env is the louder word);
  // the API key lives in the auth-scoped provider-secret store, never here.
  compatProvider?: {
    baseUrl?: string
    label?: string
    models?: string[]
  }

  // Disk cache of the org metrics-enabled check. Org-level settings change
  // rarely; persisting across processes spares every headless boot a cold
  // API call.
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // The last-applied migration set's version. Matching
  // CURRENT_MIGRATION_VERSION lets runMigrations() skip every sync
  // migration — a startup otherwise pays eleven lock+re-read save cycles.
  migrationVersion?: number
}

/**
 * Fresh-default factory. A factory (not a deep-cloned shared constant)
 * because every nested container starts empty: fresh references cost
 * nothing to mint, and no caller can mutate a shared default.
 */
export function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: DEFAULT_THEME_SETTING,
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    expandedView: 'none',
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

// The global-scope key allowlist: which keys a generic config surface may
// read/write by name (everything else is owned by its feature's own
// surface). Part of the frozen barrel contract (scripts/ownership/
// contract-inventory.json) with its isGlobalConfigKey guard.
export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'lspRecommendationDisabled',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'defaultCritter',
  'defaultProvider',
  'concourseEnabled',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
  'harnessProfilePin',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

// The project-scope key allowlist (same contract as above).
export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}
