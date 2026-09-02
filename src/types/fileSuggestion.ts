/**
 * Input passed to a user-configured `fileSuggestion` command hook.
 *
 * When `settings.fileSuggestion.type === 'command'`, the `@`-file typeahead
 * delegates ranking to an external script instead of the built-in nucleo
 * fuzzy index. The script receives this object as JSON on stdin and is
 * expected to emit one suggested path per line on stdout.
 *
 * The shape is the common hook "base input" (produced by
 * {@link createBaseHookInput} in `utils/hooks.ts`, mirroring
 * `BaseHookInputSchema` in the SDK core schemas) extended with the partial
 * path the user has typed. Unlike the event-driven hooks (PreToolUse,
 * SessionStart, …) this carries no `hook_event_name` discriminator — it is a
 * synchronous typeahead query, not a lifecycle event — so `query` is the
 * file-suggestion-specific field.
 *
 * @see executeFileSuggestionCommand (utils/hooks.ts) — the consumer.
 * @see generateFileSuggestions (hooks/fileSuggestions.ts) — the producer.
 */
export interface FileSuggestionCommandInput {
  /** Current session id (`getSessionId()`). */
  session_id: string
  /** Absolute path to the session transcript JSONL. */
  transcript_path: string
  /** Current working directory the suggestion is being requested from. */
  cwd: string
  /**
   * Active permission mode (e.g. `'default'`, `'implement'`, `'strategy'`,
   * `'sovereign'`). Omitted when no explicit mode was threaded
   * through — file-suggestion calls `createBaseHookInput()` with no
   * `permissionMode` argument, so this is typically absent.
   */
  permission_mode?: string
  /**
   * Subagent identifier. Present only when the hook fires from within a
   * subagent (e.g. a tool called by an AgentTool worker). Absent for the
   * main thread, even in `--agent` sessions.
   */
  agent_id?: string
  /**
   * Agent type name (e.g. `'general-purpose'`, `'code-reviewer'`). Present
   * when the hook fires from within a subagent (alongside `agent_id`), or on
   * the main thread of a session started with `--agent` (without `agent_id`).
   */
  agent_type?: string
  /** The partial file path the user has typed after `@`. */
  query: string
}
