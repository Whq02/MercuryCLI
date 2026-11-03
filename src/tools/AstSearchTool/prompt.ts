import { AST_BOUNDS, astLanguageNames } from '../../utils/astPatterns.js'

export const AST_SEARCH_TOOL_NAME = 'AstSearch'

export const AST_PATTERN_FIELD =
  'One complete node written as code in the target language: a fragment that is not standalone goes inside its container, and a declaration carries every part it has (a declared return type as ": $_" in TypeScript, " -> $_" in Python). $NAME matches one node and captures it; $$$NAME matches zero or more siblings and captures them; $_ and $$$ match without capturing. Names are uppercase letters, digits and underscores, a repeated name must match identical code, and spacing, line breaks and comments never matter.'

export const AST_PATH_FIELD =
  "A file or a directory; the working directory when omitted. Dot-files and dot-folders, node_modules, dist, build, out, coverage, venv, __pycache__, vendor, target and the root .gitignore's plain entries are skipped unless named here."

export const AST_GLOB_FIELD = 'Only the files matching this glob, relative to path; {a,b} lists alternatives.'

export function astLanguageField(): string {
  return `One grammar for every file, instead of each file's extension deciding; this build carries: ${astLanguageNames().join(' · ') || '(no grammar engine)'}; a file without a grammar is skipped and counted.`
}

export function getAstSearchDescription(): string {
  return `Searches code by its syntax: a pattern written as code in the target language, with meta-variables for the parts that vary, is matched against each file's parsed tree, so strings and comments never match. Matches come in file order as file:line:col with the matched code and every capture, ${AST_BOUNDS.defaultLimit} at a time by default with the rest counted; a file that does not parse is named.`
}
