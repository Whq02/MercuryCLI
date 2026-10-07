import { AST_BOUNDS, astLanguageNames } from '../../utils/astPatterns.js'

export const AST_SEARCH_TOOL_NAME = 'AstSearch'
export const AST_EDIT_TOOL_NAME_REF = 'AstEdit'

export function getAstSearchDescription(offered: ReadonlySet<string> | null = null): string {
  return `Use this over Grep to find code by its shape rather than its text: a pattern written as code in the target language, with meta-variables for the parts that vary, is matched against each file's parsed syntax tree, so strings and comments never match.

Patterns:
- ONE complete node, written as code: a call "$FN($$$ARGS)", a statement "if ($COND) { $$$BODY }", an import "import { $$$NAMES } from '$MODULE'". Wrap a fragment that is not standalone in its container: "class $_ { $$$BODY }".
- $NAME matches one node and captures it; $$$NAME matches zero or more siblings (arguments, parameters, statements) and captures them; $_ and $$$ match without capturing. Names are UPPERCASE letters, digits and _; a name used twice must match identical code; $$X and $$$name are literal text. Spacing, line breaks and comments never matter.
- A symbol by name is its declaration, written with every part it has: "function process_order($$$ARGS) { $$$BODY }", "def process_order($$$ARGS): $$$BODY"; a declared return type needs ": $_" (TypeScript) or " -> $_" (Python) after the parameters.

Scope and results:
- path is a file or a directory (the working directory when omitted); glob narrows it, relative to path: "**/*.ts", "src/**/*.py", and {a,b} for alternatives: "**/*.{ts,tsx}". The walk skips dot-files, dot-folders, node_modules, dist, build, out, coverage, venv, __pycache__, vendor, target and the root .gitignore's plain entries; name such a folder in path to search it.
- Each file's language comes from its extension — this build carries: ${astLanguageNames().join(' · ') || '(no grammar engine)'}; lang keeps only that language (and forces it on a single file). A file with no grammar is skipped and counted, a file that does not parse is reported, and neither is ever matched.
- Matches come in file order as file:line:col with the code and every capture, limit at a time (default ${AST_BOUNDS.defaultLimit}, max ${AST_BOUNDS.maxLimit}), the rest counted — page with offset; mode "count" tallies per file.${offered === null || offered.has(AST_EDIT_TOOL_NAME_REF) ? ' AstEdit rewrites exactly the matches this tool finds.' : ''}

Examples:
- { "pattern": "$FN($$$ARGS)", "path": "src", "glob": "**/*.ts" } — every call under src
- { "pattern": "print($$$ARGS)", "lang": "python", "mode": "count" } — print calls per file`
}
