// ============================================================================
//  Wards — deterministic content-rules over pending tool calls (the engine).
//
//  A ward is a named rule with regex conditions that scans the EXACT pending
//  tool input at the PreToolUse seam (Edit/Write/NotebookEdit content, Bash/
//  PowerShell commands) and denies a violating call with a TEACHING re-prompt:
//  the rule text + the matched excerpt + the compliant alternative. Rules cost
//  ZERO standing prompt bytes — they sit dormant until violated, then inject
//  exactly once per offense (the same context economics as the harness's Stop
//  gates, applied BEFORE damage instead of after).
//
//  Design: the ward fires at the PreToolUse seam — the call is fully formed,
//  the deny path is the proven FunctionHook plumbing (the commit gate's), and
//  the model retries the call rather than the stream. Protection for
//  tool-borne damage with a small engine surface. (Mid-stream abort stays a
//  possible future extension for prose-scope rules; prose is currently
//  covered by the Stop-side self-check + voice lint.)
//
//  BUILTIN rules mechanize Mercury's standing hard rules that are otherwise
//  detection-only (gate-time ratchets) or honor-only:
//   · zero-new-hex-outside-theme  (UI hard rule; ratchet cousin: width oracle)
//   · no-emoji-in-tui-source     (UI hard rule; ratchet cousin:
//                                  scripts/ui/prove-no-emoji.ts — keep the
//                                  EMOJI class here mirrored with it)
//   · no-force-push-protected    (append-only main; push-green directive)
//  Project rules load from .mercury/wards.json (same shape, additive).
//
//  Pure module: no env reads, no io at import — loadable by proofs directly.
//  Gate + registration live in src/utils/hooks/wardsHook.ts (MERCURY_WARDS).
// ============================================================================

export type WardScope = 'edit' | 'bash'

export type WardRule = {
  /** Stable rule id, shown in the denial. */
  name: string
  /** The teaching text: WHY + the compliant alternative. */
  teach: string
  scope: WardScope
  /** Regex sources, OR'd. Compiled with `flags` (default 'u'). */
  patterns: string[]
  flags?: string
  /** edit scope: rule applies only when the target path matches (regex). */
  pathPattern?: string
  /** edit scope: matching paths are exempt (the sanctioned holders). */
  allowPathPattern?: string
  /**
   * edit scope, Edit-shaped inputs only: a match counts only when the matched
   * TEXT does not also appear in old_string — moved/existing content never
   * trips the ward, only genuinely NEW content does.
   */
  newContentOnly?: boolean
  /** Skip comment-looking lines (`//`, `*`, `/*`) — default true. */
  skipCommentLines?: boolean
}

export type WardVerdict =
  | { allow: true }
  | {
      allow: false
      rule: WardRule
      excerpt: string
      line: number
      target: string
    }

/** The pending tool call as the PreToolUse hook sees it. */
export type PendingToolCall = {
  toolName: string
  input: Record<string, unknown>
}

const EDIT_TOOLS = new Set(['Edit', 'NotebookEdit'])
const WRITE_TOOLS = new Set(['Write'])
const BASH_TOOLS = new Set(['Bash', 'PowerShell'])

/** Matcher string for hook registration — every tool the engine understands. */
export const WARDS_TOOL_MATCHER = 'Edit|Write|NotebookEdit|Bash|PowerShell'

// Mirrors scripts/ui/prove-no-emoji.ts (the gate-time ratchet): pictographic
// blocks U+1F300–U+1FAFF + the emoji-presentation selector. Keep in sync.
const EMOJI_PATTERN = '[\\u{1F300}-\\u{1FAFF}]|\\uFE0F'

/**
 * The builtin Mercury wards — each mechanizes an already-ratified operator
 * rule. Keep this list SHORT and load-bearing;
 * project-specific additions belong in .mercury/wards.json.
 */
export const BUILTIN_WARDS: readonly WardRule[] = [
  {
    name: 'no-new-hex-outside-theme',
    teach:
      'Zero new hex outside the theme tokens (the UI hard rules). Import the ' +
      'token instead (mercuryPalette / sessionAccent); if a genuinely new color is needed, ' +
      'add it to mercuryPalette.ts first, then import it here.',
    scope: 'edit',
    patterns: ['#[0-9a-fA-F]{3,8}\\b'],
    pathPattern: 'src/(components|screens|commands)/.*\\.(ts|tsx)$',
    // Sanctioned hex holders as of — shrink this list when the
    // Spinner ramps are tokenized, never grow it casually.
    allowPathPattern:
      '(components/mercuryPalette\\.ts|mercury-ui/sessionAccent\\.ts' +
      '|components/Spinner/(GlimmerMessage\\.tsx|SpinnerGlyph\\.tsx|utils\\.ts))$',
    newContentOnly: true,
  },
  {
    name: 'no-emoji-in-tui-source',
    teach:
      'No emoji in live TUI sources (the UI hard rules): the marks are <Crab/> ' +
      '(product lockup) / <SessionMark/> (session-identity slots) and the sanctioned ' +
      'glyph vocabulary lives in mercury-ui glyphs. Use those or plain text.',
    scope: 'edit',
    patterns: [EMOJI_PATTERN],
    flags: 'u',
    pathPattern: 'src/(components|screens|commands)/.*\\.(ts|tsx)$',
    newContentOnly: true,
  },
  {
    name: 'no-force-push-protected',
    teach:
      'Never force-push a SHARED ref — main/master is append-only here (the ' +
      'push-green-to-main directive assumes it). Push normally after pull --rebase, or use ' +
      '--force-with-lease on a topic branch only you own.',
    scope: 'bash',
    patterns: [
      'git\\s+push[^\\n;|&]*(?:--force(?!-with-lease)|\\s-f\\b)[^\\n;|&]*\\s(?:origin\\s+)?(?:main|master)\\b',
      'git\\s+push[^\\n;|&]*\\s(?:origin\\s+)?(?:main|master)\\b[^\\n;|&]*(?:--force(?!-with-lease)|\\s-f\\b)',
    ],
    skipCommentLines: false,
  },
]

/**
 * Wards active ONLY in autonomously spawned sessions (MERCURY_SPAWNED_BY —
 * daemon workers, teammates, fired headless runs). The incident
 * class: an unattended agent recursively deleting inside the user home.
 * Operator-driven sessions are exempt — the operator's own hands stay free.
 * Inclusion is decided by the HOOK layer (wardsHook.deleteWardActive), so
 * this module stays pure. Residual (documented): variable-expanded targets
 * (`rm -rf "$DIR"`) and relative paths are not resolvable statically — the
 * spawn ledger + bash audit remain the forensic net for those.
 */
export const AUTONOMOUS_WARDS: readonly WardRule[] = [
  {
    name: 'no-home-recursive-delete',
    teach:
      'Autonomous sessions never recursively delete inside the user home (the ' +
      'deleted-workspace incident class). Do destructive cleanup inside ' +
      'your own worktree or tempdir (/tmp, $TMPDIR); if this delete is genuinely ' +
      'required, surface it to the lead/operator in your report instead of running it.',
    scope: 'bash',
    patterns: [
      // rm with a single-dash recursive flag (or --recursive) + a home-ish
      // target in the same command segment, either order.
      '\\brm\\b(?=[^\\n;|&]*\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*\\b|--recursive\\b))[^\\n;|&]*\\s(?:~(?:\\/|\\s|$)|\\$\\{?HOME|\\/Users\\/)',
      // find <home-path> … -delete
      '\\bfind\\s+(?:~(?:\\/|\\s)|\\$\\{?HOME|\\/Users\\/)[^\\n;|&]*\\s-delete\\b',
    ],
    skipCommentLines: false,
  },
]

/** Compiled-regex caches keyed by RULE IDENTITY: rule objects are built
 *  once (the builtin constants; project rules at their registration parse)
 *  and never mutated afterwards, so identity IS the invalidation — a
 *  reloaded rules file mints new objects and misses naturally. Previously
 *  every qualifying tool call (Bash/PowerShell/Edit/Write/NotebookEdit)
 *  recompiled every rule's patterns from scratch. The cached value is the
 *  POST-catch product, so an invalid pattern stays skipped (or an invalid
 *  path pattern stays in its documented fallback) on every call, exactly
 *  as the fresh compile behaved. Reuse is stateless: String.match resets a
 *  global-flagged regex per spec, and the path regexes carry no flags. */
const compiledPatterns = new WeakMap<WardRule, RegExp[]>()
const compiledPathPatterns = new WeakMap<WardRule, RegExp | null>()
const compiledAllowPathPatterns = new WeakMap<WardRule, RegExp | null>()

function cachedPathRegex(
  map: WeakMap<WardRule, RegExp | null>,
  rule: WardRule,
  source: string,
): RegExp | null {
  let re = map.get(rule)
  if (re === undefined) {
    try {
      re = new RegExp(source)
    } catch {
      re = null
    }
    map.set(rule, re)
  }
  return re
}

function compile(rule: WardRule): RegExp[] {
  const cached = compiledPatterns.get(rule)
  if (cached !== undefined) return cached
  const out: RegExp[] = []
  for (const src of rule.patterns) {
    try {
      out.push(new RegExp(src, rule.flags ?? 'u'))
    } catch {
      // Invalid pattern: skip it, keep the rest — a broken rule must never
      // break the session (understudy-gate posture).
    }
  }
  compiledPatterns.set(rule, out)
  return out
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** Extract the ward-relevant view of a pending call, or null if out of scope. */
function extractTarget(pending: PendingToolCall): {
  scope: WardScope
  path: string
  text: string
  oldText: string | undefined
} | null {
  const input = pending.input
  if (EDIT_TOOLS.has(pending.toolName)) {
    return {
      scope: 'edit',
      path: String(input.file_path ?? input.notebook_path ?? ''),
      text: String(input.new_string ?? input.new_source ?? ''),
      oldText: typeof input.old_string === 'string' ? input.old_string : undefined,
    }
  }
  if (WRITE_TOOLS.has(pending.toolName)) {
    return {
      scope: 'edit',
      path: String(input.file_path ?? ''),
      text: String(input.content ?? ''),
      oldText: undefined,
    }
  }
  if (BASH_TOOLS.has(pending.toolName)) {
    return {
      scope: 'bash',
      path: '',
      text: String(input.command ?? ''),
      oldText: undefined,
    }
  }
  return null
}

/**
 * Evaluate one pending tool call against a rule set. First violation wins
 * (rules in order — builtins first, then project rules).
 */
export function evaluateWards(
  rules: readonly WardRule[],
  pending: PendingToolCall,
): WardVerdict {
  const target = extractTarget(pending)
  if (!target || !target.text) return { allow: true }

  for (const rule of rules) {
    if (rule.scope !== target.scope) continue
    if (target.scope === 'edit') {
      if (rule.pathPattern) {
        // Invalid pattern caches null ⇒ applies stays false, as before.
        const re = cachedPathRegex(compiledPathPatterns, rule, rule.pathPattern)
        if (re === null || !re.test(target.path)) continue
      }
      if (rule.allowPathPattern) {
        // Invalid allowlist caches null ⇒ treated as absent, as before.
        const re = cachedPathRegex(compiledAllowPathPatterns, rule, rule.allowPathPattern)
        if (re !== null && re.test(target.path)) continue
      }
    }
    const regexes = compile(rule)
    if (regexes.length === 0) continue

    const skipComments = rule.skipCommentLines !== false
    const lines = target.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (skipComments && isCommentLine(line)) continue
      for (const re of regexes) {
        const m = line.match(re)
        if (!m || m[0] === undefined) continue
        // newContentOnly: content also present in old_string was merely moved.
        if (rule.newContentOnly && target.oldText !== undefined && target.oldText.includes(m[0])) {
          continue
        }
        return {
          allow: false,
          rule,
          excerpt: m[0].slice(0, 80),
          line: i + 1,
          target: target.path || pending.toolName,
        }
      }
    }
  }
  return { allow: true }
}

/**
 * Parse a project wards file (the content of .mercury/wards.json): a JSON
 * array of WardRule-shaped objects, WITH a report. Never throws — a broken
 * rules file must not break the session — but nothing is dropped silently
 * (FC-143: every malformed spelling of a deny used to allow the call with no
 * surface reporting the dropped ward; C7: a parse problem used to yield zero
 * safety rules with no word anywhere). Ordinary drift is FORGIVEN so the
 * deny still stands: scope case/whitespace folds, flags lose stray
 * whitespace, a missing name or teach is synthesized (the rule's job is the
 * deny; its label is not load-bearing). What cannot be salvaged — an
 * unfoldable scope, a pattern that does not compile, an entry with no usable
 * pattern left — is dropped WITH a problem line naming it, which the wards
 * doctor row and the registration debug log carry. `loss` is the same fact
 * in ONE line for the notification channel: what the session lost (invalid
 * JSON / wrong root shape ⇒ every rule; N unreadable entries ⇒ those rules),
 * absent when every rule serves — forgiven drift is not a loss.
 */
export function parseProjectWardsWithReport(jsonText: string): {
  rules: WardRule[]
  problems: string[]
  loss?: string
} {
  const problems: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    problems.push(
      `wards.json is not valid JSON (${error instanceof Error ? error.message.slice(0, 80) : 'parse error'}) — every project ward is inactive`,
    )
    return { rules: [], problems, loss: 'not valid JSON — its safety rules are OFF' }
  }
  if (!Array.isArray(parsed)) {
    problems.push('wards.json must be a JSON ARRAY of rules — every project ward is inactive')
    return { rules: [], problems, loss: 'not a JSON array of rules — its safety rules are OFF' }
  }
  const out: WardRule[] = []
  for (let i = 0; i < parsed.length; i++) {
    const entry: unknown = parsed[i]
    const label = (): string => {
      const e = entry as Record<string, unknown> | null
      return e && typeof e.name === 'string' && e.name ? `'${e.name}'` : `#${i + 1}`
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`rule ${label()} is not an object — dropped`)
      continue
    }
    const e = entry as Record<string, unknown>
    const name = typeof e.name === 'string' && e.name ? e.name : `project-rule-${i + 1}`
    if (name !== e.name) problems.push(`rule #${i + 1} has no name — kept as '${name}'`)
    let teach = typeof e.teach === 'string' && e.teach ? e.teach : ''
    if (!teach) {
      teach = `Denied by project ward '${name}' (.mercury/wards.json); the rule carries no teach text.`
      problems.push(`rule '${name}' has no teach text — a default was synthesized (the deny still stands)`)
    }
    const scopeRaw = e.scope
    const scopeFolded = typeof scopeRaw === 'string' ? scopeRaw.trim().toLowerCase() : ''
    if (scopeFolded !== 'edit' && scopeFolded !== 'bash') {
      problems.push(
        `rule '${name}' scope ${JSON.stringify(scopeRaw)} is not 'edit' or 'bash' — dropped (it can guard nothing)`,
      )
      continue
    }
    if (scopeFolded !== scopeRaw) problems.push(`rule '${name}' scope ${JSON.stringify(scopeRaw)} folded to '${scopeFolded}'`)
    // Flags: strip stray whitespace (the field-observed 'u ' / 'gi u'
    // spellings), then PROBE — unusable flags fall to the default rather
    // than silently voiding every pattern at compile time.
    let flags: string | undefined
    if (typeof e.flags === 'string') {
      const cleaned = e.flags.replace(/\s+/g, '')
      if (cleaned !== e.flags) problems.push(`rule '${name}' flags ${JSON.stringify(e.flags)} cleaned to '${cleaned}'`)
      if (cleaned) {
        try {
          new RegExp('', cleaned)
          flags = cleaned
        } catch {
          problems.push(`rule '${name}' flags '${cleaned}' are not valid regex flags — using the default 'u'`)
          flags = undefined
        }
      }
    } else if (e.flags !== undefined) {
      problems.push(`rule '${name}' flags must be a string — using the default 'u'`)
    }
    if (!Array.isArray(e.patterns)) {
      problems.push(`rule '${name}' has no patterns list — dropped`)
      continue
    }
    const patterns: string[] = []
    for (const p of e.patterns) {
      if (typeof p !== 'string') {
        problems.push(`rule '${name}' carries a non-string pattern — that pattern is dropped`)
        continue
      }
      try {
        new RegExp(p, flags ?? 'u')
        patterns.push(p)
      } catch {
        problems.push(`rule '${name}' pattern ${JSON.stringify(p.slice(0, 40))} does not compile — that pattern is dropped`)
      }
    }
    if (patterns.length === 0) {
      problems.push(`rule '${name}' has no usable pattern left — dropped`)
      continue
    }
    out.push({
      name,
      teach,
      scope: scopeFolded,
      patterns,
      flags,
      pathPattern: typeof e.pathPattern === 'string' ? e.pathPattern : undefined,
      allowPathPattern:
        typeof e.allowPathPattern === 'string' ? e.allowPathPattern : undefined,
      newContentOnly: e.newContentOnly === true,
      skipCommentLines:
        typeof e.skipCommentLines === 'boolean' ? e.skipCommentLines : undefined,
    })
  }
  const dropped = parsed.length - out.length
  return dropped > 0
    ? { rules: out, problems, loss: `${dropped} of ${parsed.length} rules unreadable — dropped` }
    : { rules: out, problems }
}

/** The LOSS view (the C7 disclosure shape): the rules plus one line naming
 *  what was lost, or no line when every rule serves. */
export function parseProjectWardsDetailed(jsonText: string): {
  rules: WardRule[]
  problem?: string
} {
  const { rules, loss } = parseProjectWardsWithReport(jsonText)
  return loss === undefined ? { rules } : { rules, problem: loss }
}

/** Parse a project wards file; the report-free view (see above). */
export function parseProjectWards(jsonText: string): WardRule[] {
  return parseProjectWardsWithReport(jsonText).rules
}

/** The denial re-prompt: rule + excerpt + the compliant alternative. */
export function buildWardDenial(
  verdict: Extract<WardVerdict, { allow: false }>,
  toolName: string,
): string {
  return (
    `Ward '${verdict.rule.name}' blocked this ${toolName} call — matched ` +
    `"${verdict.excerpt}" (${verdict.target}:${verdict.line}). ${verdict.rule.teach} ` +
    `This rule is mechanical: re-issuing the same content will be denied again; ` +
    `rewrite the call to comply.`
  )
}
