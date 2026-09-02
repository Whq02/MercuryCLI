import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { ThemeName } from '../../utils/theme.js'

/**
 * Context handed to a {@link Tip}'s relevance/content callbacks so a tip can
 * decide whether it applies to the current session and render itself against
 * the active theme.
 *
 * Constructed at the spinner call-site (REPL) from the live session state:
 * the current theme, the read-file LRU cache, and the set of CLI tools the
 * user has invoked via Bash this session. Every field beyond `theme` is
 * optional because relevance checks must tolerate a bare/headless call
 * (`getRelevantTips()` / `getTipToShowOnSpinner()` with no argument).
 */
export type TipContext = {
  /** Active theme name, used by content renderers to colorize their output. */
  theme: ThemeName
  /**
   * The session's read-file state cache. Tips inspect its keys (file paths)
   * via `cacheKeys(...)` to fire on file-type signals (e.g. editing `.css`).
   */
  readFileState?: FileStateCache
  /**
   * The set of base CLI commands the user has run through the Bash tool this
   * session (e.g. `"vercel"`). Tips match against `.has(cmd)` / `.size`.
   */
  bashTools?: Set<string>
}

/**
 * A single spinner tip: a stable id, a lazy theme-aware content renderer, a
 * relevance predicate, and a cooldown measured in sessions-since-last-shown.
 *
 * The registry holds a `Tip[]` whose elements freely use either the zero-arg
 * or the typed-arg form of `content`/`isRelevant`; the parameter types are
 * therefore optional so both lambda shapes are assignable.
 */
export type Tip = {
  /** Stable identifier, used for cooldown bookkeeping and analytics. */
  id: string
  /**
   * Lazily renders the tip text. Receives the active theme so it can colorize
   * (e.g. via `color('suggestion', ctx.theme)`); tips that don't need it
   * declare a zero-arg form, which is assignable here.
   *
   * Declared as a method signature so its parameter is bivariant: registry
   * entries supply either `async () => ...` (zero-arg) or
   * `async (ctx: { theme: ThemeName }) => ...` and both must be assignable.
   */
  content(ctx: { theme: ThemeName }): Promise<string>
  /** Number of sessions to wait after showing before this tip is eligible again. */
  cooldownSessions: number
  /**
   * Whether this tip applies to the current session. The context is optional
   * so a headless/no-context call (`getRelevantTips()`) still type-checks.
   *
   * Declared as a method signature for bivariant parameters: registry entries
   * supply `async () => true`, `async () => boolean`, AND
   * `async (context: TipContext) => ...` (a required-param lambda) — only the
   * bivariant method form accepts all three while the call site passes a
   * possibly-`undefined` context.
   */
  isRelevant(context?: TipContext): Promise<boolean>
}
