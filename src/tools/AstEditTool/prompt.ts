import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { AST_BOUNDS, astLanguageNames } from '../../utils/astPatterns.js'
import { AST_SEARCH_TOOL_NAME } from '../AstSearchTool/prompt.js'

export const AST_EDIT_TOOL_NAME = 'AstEdit'

export function getAstEditDescription(offered: ReadonlySet<string> | null = null): string {
  const pattern = offered === null || offered.has(AST_SEARCH_TOOL_NAME)
    ? 'Patterns, path, glob ({a,b} for alternatives) and lang work as in AstSearch, which finds exactly the matches this tool rewrites — search first when unsure what will change.'
    : `A pattern is ONE complete node written as code, e.g. "$FN($$$ARGS)" or "if ($COND) { $$$BODY }"; wrap a fragment in its container ("class $_ { $$$BODY }"). $NAME matches one node and captures it, $$$NAME zero or more siblings; $_ and $$$ match without capturing; names are UPPERCASE; spacing, line breaks and comments never matter. path is a file or a directory (the working directory when omitted), glob narrows it ({a,b} for alternatives), and each file's language comes from its extension — this build carries: ${astLanguageNames().join(' · ') || '(no grammar engine)'}; lang keeps only that language (and forces it on a single file).`
  return `Use this over Edit to rewrite every match of a code shape at once, across files, as one reviewed change: each match of a structural pattern is replaced by a rewrite built from its captures.

- ${pattern}
- The rewrite is code in the target language: $NAME and $$$NAME insert the captured source verbatim; "" deletes the matched node (a node that owns its line takes the line with it). Every meta-variable in the rewrite must be captured by the pattern; $_ and $$$ cannot be inserted.
- Two calls, always: first without apply — the unified diff per file and a plan "ae-…", nothing written; then the same arguments with apply: true and that plan. Apply refuses, writing nothing, when a file, the pattern, the rewrite or the scope differs from that dry run: run the dry run again and use its plan. Apply writes through the edit permission ask, with /rewind snapshots, atomic writes with rollback, re-read verification and one change receipt${changeTransactionEnabled() ? ", and names each file's fresh anchor" : ''}.
- Refused by name, nothing written: a match nested inside another (narrow the pattern or the scope), a result that would not parse, a rewrite naming an uncaptured meta-variable, more than ${AST_BOUNDS.editMaxFiles} files or ${AST_BOUNDS.editMaxMatches} matches. To change only some matches, put the code that tells them apart into the pattern, or narrow path or glob.
- For a one-off textual change, Edit is the better tool.

Examples:
- { "pattern": "oldName($$$ARGS)", "rewrite": "newName($$$ARGS)", "path": "src" } — dry run: the diff and a plan
- { "pattern": "oldName($$$ARGS)", "rewrite": "newName($$$ARGS)", "path": "src", "apply": true, "plan": "ae-1a2b3c4d5e6f" } — write exactly that dry run`
}
