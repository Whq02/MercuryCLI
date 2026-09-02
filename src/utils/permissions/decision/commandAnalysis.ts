/**
 * CommandAnalysisProvider — the typed seam between the permission decision
 * domain and the shell command-language parsers.
 *
 * The parsers are PINNED DEPENDENCIES: not reimplemented, isolated behind
 * this one provider object and corpus-pinned
 * (scripts/decisions/prove-command-analysis.ts). The permission-entry
 * consumers — bashPermissions.ts, powershellPermissions.ts,
 * shouldUseSandbox.ts, and the decision package itself — take their parser
 * operations from `pinnedCommandAnalysis`; none of them import a parser
 * module directly (the corpus proof ratchets this). Swapping a parser means
 * changing THIS module and re-recording the corpus, nothing else.
 *
 * Two operations carry effects and are bound, never driven, by the corpus:
 *   • getCommandSubcommandPrefix — API-backed (model prefix extraction,
 *     memoized; cache cleared via clearCommandPrefixCaches on /clear);
 *   • parsePowerShellCommand — spawns pwsh to parse (Windows lane).
 * Everything else is pure over its inputs. parseCommandRaw is the pinned
 * null-stub (the tree-sitter lane is stripped in this build — callers take
 * the split-command fallback path; pinned as-is by the corpus).
 */
import {
  checkSemantics,
  nodeTypeId,
  parseForSecurityFromAst,
} from '../../bash/ast.js'
import {
  extractOutputRedirections,
  getCommandSubcommandPrefix,
  splitCommand_DEPRECATED,
} from '../../bash/commands.js'
import { parseCommandRaw } from '../../bash/parser.js'
import { tryParseShellCommand } from '../../bash/shellQuote.js'
import {
  classifyCommandName,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  parsePowerShellCommand,
  stripModulePrefix,
} from '../../powershell/parser.js'

// The provider's type vocabulary — re-exported so consumers need no direct
// parser-module imports for their annotations either.
export type {
  ParseForSecurityResult,
  Redirect,
  SimpleCommand,
} from '../../bash/ast.js'
export type { CommandPrefixResult } from '../../bash/commands.js'
export { PARSE_ABORTED, type Node } from '../../bash/parser.js'
export type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../powershell/parser.js'
export { PS_TOKENIZER_DASH_CHARS } from '../../powershell/parser.js'

// ── The intra-tool analysis pass surface (Phase 5 seam widening) ─────────────
// The BashTool/PowerShellTool validation helpers (path/sed/mode/readOnly/
// gitSafety/security twins + bashCommandHelpers/commandSemantics) take their
// parser operations through THIS gateway as direct live re-exports — same
// single-module swap point as the provider object, without per-call wrapper
// boilerplate (ESM live bindings are cycle-safe; consumers resolve at call
// time). The corpus proof's seam ratchet covers these files too.
export {
  extractOutputRedirections,
  isUnsafeCompoundCommand_DEPRECATED,
  splitCommand_DEPRECATED,
  splitCommandWithOperators,
} from '../../bash/commands.js'
export { parseForSecurity } from '../../bash/ast.js'
export type { TreeSitterAnalysis } from '../../bash/treeSitterAnalysis.js'
export { extractHeredocs } from '../../bash/heredoc.js'
export {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from '../../bash/shellQuote.js'
export {
  buildParsedCommandFromRoot,
  type IParsedCommand,
  ParsedCommand,
} from '../../bash/ParsedCommand.js'
export {
  COMMON_ALIASES,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getPipelineSegments,
  getVariablesByScope,
  hasCommandNamed,
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../../powershell/parser.js'

/**
 * The operations the permission chain consumes from the command-language
 * parsers. `typeof` bindings pin the exact live signatures — a replacement
 * provider must be call-compatible with every one of them.
 */
export interface CommandAnalysisProvider {
  // ── Bash lane ────────────────────────────────────────────────────────────
  /** Tree-sitter parse to an AST root (pinned null-stub in this build). */
  parseCommandRaw: typeof parseCommandRaw
  /** Security-focused simple-command extraction from a parsed root. */
  parseForSecurityFromAst: typeof parseForSecurityFromAst
  /** Semantic red-flags over extracted simple commands. */
  checkSemantics: typeof checkSemantics
  /** Stable numeric ids for AST node types (analytics vocabulary). */
  nodeTypeId: typeof nodeTypeId
  /** Compound-command split (the _DEPRECATED shell-quote splitter — the live
   *  fallback path while the tree-sitter lane is stubbed). */
  splitCommand: typeof splitCommand_DEPRECATED
  /** API-BACKED memoized subcommand prefix extraction (never corpus-driven). */
  getCommandSubcommandPrefix: typeof getCommandSubcommandPrefix
  /** Output-redirection extraction for display + danger flagging. */
  extractOutputRedirections: typeof extractOutputRedirections
  /** Tokenize via the vendored shell-quote lane (null on parse failure). */
  tryParseShellCommand: typeof tryParseShellCommand
  // ── PowerShell lane ──────────────────────────────────────────────────────
  /** Parse via a spawned pwsh AST dump (EFFECTFUL; never corpus-driven). */
  parsePowerShellCommand: typeof parsePowerShellCommand
  /** Pure security-flag derivation over a parsed PS command. */
  deriveSecurityFlags: typeof deriveSecurityFlags
  /** Every command name reachable in a parsed PS command (pure). */
  getAllCommandNames: typeof getAllCommandNames
  /** File redirections of a parsed PS command (pure). */
  getFileRedirections: typeof getFileRedirections
  /** Strip Module\ prefixes from a PS command name (pure). */
  stripModulePrefix: typeof stripModulePrefix
  /** Read/write/dangerous classification of a PS command name (pure). */
  classifyCommandName: typeof classifyCommandName
}

/** The pinned production provider — the current parsers, bound one-to-one. */
export const pinnedCommandAnalysis: CommandAnalysisProvider = {
  parseCommandRaw,
  parseForSecurityFromAst,
  checkSemantics,
  nodeTypeId,
  splitCommand: splitCommand_DEPRECATED,
  getCommandSubcommandPrefix,
  extractOutputRedirections,
  tryParseShellCommand,
  parsePowerShellCommand,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  stripModulePrefix,
  classifyCommandName,
}
