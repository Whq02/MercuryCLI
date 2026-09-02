
export type WardScope = 'edit' | 'bash'

export type WardRule = {
  name: string
  teach: string
  scope: WardScope
  patterns: string[]
  flags?: string
  pathPattern?: string
  allowPathPattern?: string
  newContentOnly?: boolean
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

export type PendingToolCall = {
  toolName: string
  input: Record<string, unknown>
}

const EDIT_TOOLS = new Set(['Edit', 'NotebookEdit'])
const WRITE_TOOLS = new Set(['Write'])
const BASH_TOOLS = new Set(['Bash', 'PowerShell'])

export const WARDS_TOOL_MATCHER = 'Edit|Write|NotebookEdit|Bash|PowerShell'

const EMOJI_PATTERN = '[\\u{1F300}-\\u{1FAFF}]|\\uFE0F'

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
      'Never force-push a SHARED ref — main/master and party/* lane branches ' +
      'are append-only here (the push-green-to-main directive + the federation ' +
      'git doctrine assume it). Push normally after pull --rebase, or use ' +
      '--force-with-lease on a topic branch only you own.',
    scope: 'bash',
    patterns: [
      'git\\s+push[^\\n;|&]*(?:--force(?!-with-lease)|\\s-f\\b)[^\\n;|&]*\\s(?:origin\\s+)?(?:main|master|party\\/[^\\s;|&]+)\\b',
      'git\\s+push[^\\n;|&]*\\s(?:origin\\s+)?(?:main|master|party\\/[^\\s;|&]+)\\b[^\\n;|&]*(?:--force(?!-with-lease)|\\s-f\\b)',
    ],
    skipCommentLines: false,
  },
]

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
      '\\brm\\b(?=[^\\n;|&]*\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*\\b|--recursive\\b))[^\\n;|&]*\\s(?:~(?:\\/|\\s|$)|\\$\\{?HOME|\\/Users\\/)',
      '\\bfind\\s+(?:~(?:\\/|\\s)|\\$\\{?HOME|\\/Users\\/)[^\\n;|&]*\\s-delete\\b',
    ],
    skipCommentLines: false,
  },
]

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
    }
  }
  compiledPatterns.set(rule, out)
  return out
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

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
        const re = cachedPathRegex(compiledPathPatterns, rule, rule.pathPattern)
        if (re === null || !re.test(target.path)) continue
      }
      if (rule.allowPathPattern) {
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

export function parseProjectWardsDetailed(jsonText: string): {
  rules: WardRule[]
  problem?: string
} {
  const { rules, loss } = parseProjectWardsWithReport(jsonText)
  return loss === undefined ? { rules } : { rules, problem: loss }
}

export function parseProjectWards(jsonText: string): WardRule[] {
  return parseProjectWardsWithReport(jsonText).rules
}

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
