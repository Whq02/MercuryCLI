/**
 * The ONE pattern-intake door for the search binary's `--glob` values: the
 * Glob tool's pattern and every token of the Grep tool's glob field pass
 * here before they reach ripgrep.
 *
 * On win32 the model is primed with backslashes — ripgrep prints its
 * relative paths that way on Windows — and a backslash-spelled pattern
 * (`src\**\*.ts`) handed to ripgrep verbatim matches nothing: its matcher
 * normalises candidate paths to forward slashes, and its glob parser treats
 * no backslash as an escape on Windows, so rewriting every backslash to a
 * forward slash loses nothing and makes the pattern match. On POSIX a
 * backslash IS the glob escape (`a\[1\].ts` names the literal file
 * `a[1].ts`), so the door is a no-op there. Pure and import-free: the
 * platform is a parameter so both arms are table-provable on either host.
 */
export function normalizeGlobPattern(pattern: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return pattern
  return pattern.replace(/\\/g, '/')
}

/**
 * The Grep tool's glob field, split into its `--glob` values: whitespace-
 * split, then comma-split — except a token carrying a brace pair, which
 * passes through whole so brace expansion survives — each value through the
 * separator door.
 */
export function splitGrepGlobField(field: string, platform: NodeJS.Platform = process.platform): string[] {
  const values: string[] = []
  for (const token of field.split(/\s+/).filter(Boolean)) {
    if (token.includes('{') && token.includes('}')) {
      values.push(normalizeGlobPattern(token, platform))
    } else {
      for (const piece of token.split(',').filter(Boolean)) {
        values.push(normalizeGlobPattern(piece, platform))
      }
    }
  }
  return values
}
