import { AST_BOUNDS, astLanguageNames, PATTERN_GRAMMAR_LINES } from '../../utils/astPatterns.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'

/**
 * The AstSearch tool's name constant and model-facing text. One string
 * serves as both the description and the prompt, so the two never drift.
 */

/** Contract data: the model-visible tool name. */
export const AST_SEARCH_TOOL_NAME = 'AstSearch'

export const AST_EDIT_TOOL_NAME_REF = 'AstEdit'

export function getAstSearchDescription(): string {
  return `Find code by its syntax shape: a pattern written in the target language, with meta-variables for the parts that vary, matched against the parsed syntax tree of every file in scope — never against text.

Usage:
- ${PATTERN_GRAMMAR_LINES[0]}
- ${PATTERN_GRAMMAR_LINES[1]}
- ${PATTERN_GRAMMAR_LINES[2]}
- The language is detected per file from its extension — this build carries: ${astLanguageNames().join(' · ') || '(no grammar engine)'}; pass lang to force one. A file whose extension has no grammar here is skipped and counted, never text-matched; a file that does not parse is reported, never guessed over.
- Results are file:line:col ranges with the matched code and every capture, in file order, bounded by limit (default ${AST_BOUNDS.defaultLimit}, max ${AST_BOUNDS.maxLimit}) with the remainder counted — page with offset. mode "count" tallies matches per file instead. Scope with path (a file or a directory; the working directory when omitted) and glob ("**/*.ts").
- Reach for this when the SHAPE matters (calls with a given arity, a construct inside a construct, a declaration form); reach for ${GREP_TOOL_NAME} for plain text, comments and strings. ${AST_EDIT_TOOL_NAME_REF} rewrites exactly the matches this tool finds.

Examples:
- { "pattern": "$FN($$$ARGS)", "path": "src", "glob": "**/*.ts" } — every call under src, with $FN and $$$ARGS captured
- { "pattern": "print($$$ARGS)", "lang": "python", "mode": "count" } — how many print calls, per file`
}
