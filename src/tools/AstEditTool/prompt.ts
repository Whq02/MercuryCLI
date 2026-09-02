import { AST_BOUNDS, astLanguageNames, PATTERN_GRAMMAR_LINES } from '../../utils/astPatterns.js'
import { AST_SEARCH_TOOL_NAME } from '../AstSearchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'

/**
 * The AstEdit tool's name constant and model-facing text. One string serves
 * as both the description and the prompt, so the two never drift.
 */

/** Contract data: the model-visible tool name. */
export const AST_EDIT_TOOL_NAME = 'AstEdit'

export function getAstEditDescription(): string {
  return `Rewrite code by its syntax shape: every match of a structural pattern is replaced by a rewrite built from the captured meta-variables, across files, as one reviewed change. Without apply this is a dry run — the unified diff per file and a plan token, nothing written; apply:true with that token writes through Mercury's file-write door (the edit permission ask, file snapshots for /rewind, atomic writes with rollback, re-read verification, one change receipt).

Usage:
- ${PATTERN_GRAMMAR_LINES[0]}
- ${PATTERN_GRAMMAR_LINES[1]}
- The rewrite is code in the target language: $NAME and $$$NAME insert the captured source verbatim; "" deletes the matched node (a node that owns its line takes the line with it). Every meta-variable in the rewrite must be captured by the pattern; anonymous $_ and $$$ cannot be inserted.
- Two calls, always: first without apply to read the diff and receive the plan "ae-…"; then with apply:true and that plan to write. Apply refuses when any file, the pattern, the rewrite or the scope differs from that dry run — run the dry run again and use the new plan.
- Refused by name, nothing written: a match nested inside another match (narrow the pattern or the scope), a rewrite that would leave a file unparsable, a rewrite naming a meta-variable the pattern does not capture, more than ${AST_BOUNDS.editMaxFiles} files or ${AST_BOUNDS.editMaxMatches} matches in one edit.
- The match set is exactly ${AST_SEARCH_TOOL_NAME}'s for the same pattern and scope: search first when unsure what will change. Language is detected per file from the extension — this build carries: ${astLanguageNames().join(' · ') || '(no grammar engine)'}; pass lang to force one. For a one-off textual change, ${FILE_EDIT_TOOL_NAME} is the better tool.

Examples:
- { "pattern": "oldName($$$ARGS)", "rewrite": "newName($$$ARGS)", "path": "src" } — dry run: the diff plus a plan token
- { "pattern": "oldName($$$ARGS)", "rewrite": "newName($$$ARGS)", "path": "src", "apply": true, "plan": "ae-1a2b3c4d5e6f" } — write exactly that dry run`
}
