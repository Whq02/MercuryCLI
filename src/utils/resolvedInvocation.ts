// ============================================================================
//  resolvedInvocation — the canonical structured-invocation owner (
// {executablePath, args[], cwd?} for direct spawn/execFile, plus the
//  ONE legacy parser for old configured command STRINGS ('code --wait',
//  '"C:\\Program Files\\Editor\\ed.exe" -n', 'my\ editor --flag').
//
//  Laws:
//   · shell interpretation NEVER happens here — a configured string that
//     needs shell features must be run through a shell EXPLICITLY by its
//     owner (headersHelper's shell:true is a deliberate, documented choice);
//   · the parser understands double quotes, single quotes and
//     backslash-escaped spaces — the three shapes real EDITOR/BROWSER-style
//     configs use — and nothing else (no expansion, no substitution);
//   · executables are never split on whitespace anywhere else (the WP-2
//     class: 'C:\\Program Files\\...' executing 'C:\\Program').
// ============================================================================

export interface ResolvedInvocation {
  executablePath: string
  args: string[]
  cwd?: string
}

/**
 * The ONE legacy parser. Tokenizes a configured command string without any
 * shell semantics beyond quoting: "..." and '...' group; backslash escapes
 * the next character OUTSIDE single quotes; whitespace separates tokens.
 * An empty/whitespace-only string yields an empty executablePath — callers
 * treat that as not-configured.
 */
export function parseLegacyCommandString(raw: string, cwd?: string): ResolvedInvocation {
  const tokens: string[] = []
  let cur = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (quote === '"') {
      // Inside double quotes a backslash is LITERAL — '"C:\\Program
      // Files\\ed.exe"' keeps its separators (the win32 config shape).
      if (c === '"') quote = null
      else cur += c
      continue
    }
    if (c === '\\' && i + 1 < raw.length) {
      cur += raw[++i]!
      started = true
      continue
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'"
      started = true
      continue
    }
    if (c === ' ' || c === '\t') {
      if (started || cur.length > 0) {
        tokens.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += c
    started = true
  }
  if (started || cur.length > 0) tokens.push(cur)
  return {
    executablePath: tokens[0] ?? '',
    args: tokens.slice(1),
    ...(cwd !== undefined ? { cwd } : {}),
  }
}
