// ============================================================================
//  src/types/command.ts — the command vocabulary: three command kinds over
//  one base, the local/JSX execution contracts, and the resume-entrypoint
//  telemetry union.
// ============================================================================
import type * as React from 'react'
import type { UUID } from 'crypto'
import type { ToolUseContext } from '../Tool.js'
import type { HooksSettings } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Message } from './message.js'
import type { LogOption } from './logs.js'
import type { ContentBlockParam } from './wire.js'
import type { ExtensionManifest } from '../extensions/manifest.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { IDEExtensionInstallationStatus, IdeType } from '../utils/ide.js'
import type { ThemeName } from '../utils/theme.js'

/**
 * Where a command was contributed from — used for collision and precedence
 * reporting. Re-declared inline (not imported) by design.
 */
type CommandSource =
  | 'mcp'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'extension'
  | 'builtin'
  | 'bundled'

/**
 * Origin labels — structurally the same union the skill loader exports,
 * deliberately re-declared here to avoid the import.
 */
type LoadedFromLabel =
  | 'legacy-commands'
  | 'skills'
  | 'extension'
  | 'managed'
  | 'bundled'
  | 'mcp'

/**
 * Availability declares which auth/provider environments a command exists
 * in — a STATIC auth requirement, explicitly distinct from enablement (a
 * runtime toggle). No availability = available everywhere; declaring
 * claude-ai + console hides the command from gateway providers and custom
 * base URLs. `any-provider-credential` is provider-derived: met when ANY
 * provider family the catalogue knows has a credential (the owning
 * resolvers answer — never a hardcoded provider pair). Contract data — the
 * availability predicate matches on these.
 */
export type CommandAvailability = 'claude-ai' | 'console' | 'any-provider-credential'

/**
 * The one sanctioned UI route-alias kind (contract data — the composer
 * switches on it): the submission becomes an immediate route action in
 * interactive sessions; the command body never runs there.
 */
export type UiRouteAliasKind = 'concourse'

/** The owning extension, carried by every extension-contributed command. */
export type ExtensionCommandInfo = {
  manifest: ExtensionManifest
  /** `<name>@<source label>` */
  id: string
}

/**
 * Session-scoped live values the slash menu can hand a command's
 * `currentValue` getter — the slices only a React provider owns (module-
 * level owners are read directly by the getter instead). All optional:
 * outside a provider every member is undefined and rows render valueless.
 */
export type MenuLiveState = {
  effortValue?: EffortValue
  permissionMode?: string
  mainLoopModelForSession?: string | null
}

export type CommandBase = {
  name: string
  description: string
  /** Shorter menu-facing description; the picker falls back to description. */
  menuDescription?: string
  /**
   * The current value of the mode/setting this command owns, rendered live
   * in its slash-menu row (the menu doubles as a status readout). Resolved
   * at menu-open time from the same state the command itself reads; must
   * be cheap and synchronous — return undefined to render without one.
   */
  currentValue?: (live: MenuLiveState) => string | undefined
  /** The description came from the user's own frontmatter. */
  hasUserSpecifiedDescription?: boolean
  /** Enablement predicate; absent = enabled. */
  isEnabled?: () => boolean
  isHidden?: boolean
  aliases?: string[]
  isMcp?: boolean
  argumentHint?: string
  whenToUse?: string
  version?: string
  /** The model may not invoke this command. */
  disableModelInvocation?: boolean
  /** The session KIT holds this skill at 'invocable' — the /name door only
   *  (the mark rides a COPY whose disableModelInvocation is set, so every
   *  model-facing filter follows; the author's own switch is never cleared
   *  — the kit narrows, never widens; L24(5)). */
  kitSkillState?: 'invocable'
  /** Absent = user-invocable (and visible). */
  userInvocable?: boolean
  loadedFrom?: LoadedFromLabel
  /** Workflow badge for autocomplete. */
  kind?: 'workflow'
  source?: CommandSource
  /** Bypasses the queue. */
  immediate?: boolean
  /** Redacts arguments from conversation history. */
  isSensitive?: boolean
  /** User-facing-name override; resolve via getCommandName(). */
  userFacingName?: () => string
  availability?: CommandAvailability[]
  /**
   * The command's only meaning is the Session Concourse — a surface over
   * the fleet of sessions (its seats, crews, runs, the tower). In THE
   * PLAIN WORLD (a `--chat` boot, or the concourse switched off) it is not
   * enabled: it leaves the table, and typed by name it answers the
   * concourse-off sentence — never "Unknown skill". commands/enablement.ts
   * folds this into the one enablement read.
   */
  needsConcourse?: boolean
  /**
   * A RETIRED door: the command's name stays registered so a typed /name
   * answers this reason (the plain-world honesty grammar — never "Unknown
   * skill"), but it is never enabled and never listed. The sentence
   * completes "The /name command is retired — …". commands/enablement.ts
   * folds this into the one enablement read.
   */
  retired?: string
  /**
   * A development fixture route. A command carrying this must also gate
   * its enablement on the development-surfaces boundary — the pairing is
   * enforced by the effective-catalogue prover, not by this type.
   */
  devOnly?: boolean
  /**
   * The owning route when this command is a thin alias mounting another
   * surface's journey (projections say "alias of X" instead of inventing a
   * second maturity for one owner). Defaults to the command's own name.
   */
  canonicalRoute?: string
  /**
   * With an agent transcript on screen: does this command act on the local
   * session (`session`, the default) or on the agent being watched
   * (`agent`, addressed over its channel)? Authoritative — consulted
   * during intent classification, ahead of destination selection; a
   * surface keeping its own list of "agent commands" is the defect this
   * field prevents.
   */
  scope?: 'session' | 'agent'
}

/**
 * A skill: expands into a prompt. `context: 'inline'` (the default)
 * expands into the current conversation; `'fork'` runs in a subagent with
 * its own context window and token budget, using `agent` when declared.
 */
export type PromptCommand = CommandBase & {
  type: 'prompt'
  progressMessage: string
  /** Prompt content length, for token estimation. */
  contentLength: number
  source: CommandSource
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  extensionInfo?: ExtensionCommandInfo
  /** Non-interactive sessions cannot run this command. */
  disableNonInteractive?: boolean
  /** Hooks registered when the skill is invoked. */
  hooks?: HooksSettings
  /**
   * The skill's own directory; sets MERCURY_EXTENSION_ROOT for the skill's
   * own hooks (a skill promoted to an extension keeps its hook scripts).
   */
  skillRoot?: string
  context?: 'inline' | 'fork'
  /** Agent type used when context is 'fork'. */
  agent?: string
  /**
   * Glob path filters: the skill stays invisible until the model touches a
   * matching file.
   */
  pathFilters?: string[]
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

/** What a local command's body may return. */
export type LocalCommandResult =
  | { type: 'text'; value: string }
  | {
      type: 'compact'
      compactionResult: {
        boundaryMarker: Message
        summaryMessages: Message[]
        messagesToKeep?: Message[]
        attachments: Message[]
        hookResults: Message[]
        userDisplayMessage?: string
      }
      displayText?: string
    }
  | { type: 'skip' }

export type LocalCommandCall = (
  args: string,
  context: LocalJSXCommandContext,
) => Promise<LocalCommandResult>

export type LocalCommandModule = {
  call: LocalCommandCall
}

/**
 * Where a command executes — THE ONE DISPATCH RULE over one command table.
 * Every session is a managed session in its own process; the screen is the
 * face over the focused chat. A command acts on the SCREEN (the composer,
 * the keys, the view, the blank chat) or on the SESSION (the conversation,
 * its model, its context, its tools) — `commandSeat` (src/commands.ts)
 * answers, and both the screen's dispatch and the session runner's table
 * read that one answer.
 */
export type CommandSeat = 'screen' | 'session'

/** Runs code and returns a text/compaction/skip result. Lazy-loaded. */
type LocalCommand = CommandBase & {
  type: 'local'
  /** REQUIRED: whether the headless runner may execute this command. */
  supportsNonInteractive: boolean
  /**
   * The command acts on the SCREEN (the composer, the keys, the view, the
   * blank chat): its body runs in the screen process against the focused
   * connector, never in a session's runner. Absent = the SESSION runs it.
   */
  seat?: 'screen'
  /**
   * USER-PRIVATE (the command-privacy law):
   * the command's line and output are for the operator ALONE —
   * they never enter any model conversation, never start a turn, never
   * bill a token, on every seat. `commandSeat` folds this into the screen
   * seat (the line never leaves the screen process; the receipt paints as
   * display rows), and the runner's slash path consumes a stray
   * words-level arrival with ZERO persisted rows (the never-reaches
   * defense, the credential-overlay scope's sibling).
   */
  userPrivate?: boolean
  /**
   * STOP-CLASS (the /halt law): the command's job is to stop running work,
   * so it must act even while a turn runs — the screen's dispatch fires the
   * focused chat's interrupt door FIRST, then the body. Only meaningful on
   * screen-seat commands (a session runner cannot brake itself mid-turn).
   */
  interruptFirst?: boolean
  /**
   * The route-alias marker: in interactive sessions the composer consumes
   * the submission before history, persistence, rewind indexing and
   * provider dispatch — the body never runs there. The registry entry
   * still exists for discovery and for non-interactive contexts, where the
   * body's own refusal text answers.
   */
  uiRouteAlias?: UiRouteAliasKind
  load: () => Promise<LocalCommandModule>
}

export type CommandResultDisplay = 'skip' | 'system' | 'user'

export type LocalJSXCommandOnDone = (
  result?: string,
  options?: {
    /** Defaults to 'user'. */
    display?: CommandResultDisplay
    /** Additional meta messages: model-visible, UI-hidden. */
    metaMessages?: string[]
    shouldQuery?: boolean
    nextInput?: string
    submitNextInput?: boolean
  },
) => void

/** How a resume came about (contract data — telemetry vocabulary). The
 *  `switchboard` member marks the sanctioned in-place concourse handover. */
export type ResumeEntrypoint =
  | 'cli_flag'
  | 'slash_command_picker'
  | 'slash_command_session_id'
  | 'slash_command_title'
  | 'fork'
  | 'switchboard'

export type LocalJSXCommandContext = ToolUseContext & {
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  canUseTool?: CanUseToolFn
  onChangeAPIKey: () => void
  onChangeDynamicMcpConfig?: (
    config: Record<string, ScopedMcpServerConfig>,
  ) => void
  onInstallIDEExtension?: (ide: IdeType) => void
  resume?: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
  options: ToolUseContext['options'] & {
    dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
    ideInstallationStatus?: IDEExtensionInstallationStatus | null
    theme: ThemeName
  }
}

export type LocalJSXCommandCall = (
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
) => Promise<React.ReactNode | null>

export type LocalJSXCommandModule = {
  call: LocalJSXCommandCall
}

/** Renders an interactive surface. Lazy-loaded. */
type LocalJSXCommand = CommandBase & {
  type: 'local-jsx'
  load: () => Promise<LocalJSXCommandModule>
}

export type Command = PromptCommand | LocalCommand | LocalJSXCommand

/** The user-visible name: the override's result, else the name. */
export function getCommandName(command: Command): string {
  return command.userFacingName?.() ?? command.name
}

/** Enablement: the predicate's result, else true. */
export function isCommandEnabled(command: Command): boolean {
  return command.isEnabled ? command.isEnabled() : true
}
