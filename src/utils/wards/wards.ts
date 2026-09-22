
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
  outsideQuotes?: boolean
  refusal?: boolean
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
  shellCommand?: string
}

const EDIT_TOOLS = new Set(['Edit', 'NotebookEdit'])
const WRITE_TOOLS = new Set(['Write'])
export const WARDS_TOOL_MATCHER = '*'

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

const WORD_END = '(?![\\w./-])'
const CMD_START = '(?:^|[;&|(`{]|\\$\\(|\\b(?:then|do|else)\\b|\\bsudo\\s+)\\s*'

export const REFUSAL_WARDS: readonly WardRule[] = [
  { name: 'npm-exec-yes', scope: 'bash', teach: 'npx/npm exec with an auto-confirm flag runs an unvetted remote package non-interactively.', refusal: true, skipCommentLines: false, patterns: ['\\b(?:npx|npm\\s+exec|pnpm\\s+dlx|yarn\\s+dlx)\\b[^\\n]*\\s(?:-y|--yes)\\b'] },
  { name: 'git-install-sha', scope: 'bash', teach: 'pip/npm install from a git URL pinned to an arbitrary commit SHA (bypasses release review).', refusal: true, skipCommentLines: false, patterns: ['\\b(?:pip|pip3|npm|pnpm|yarn)\\s+install\\b[^\\n]*git\\+[^\\s]+@[0-9a-f]{7,40}\\b'] },
  { name: 'curl-pipe-shell', scope: 'bash', teach: 'curl|bash / wget|sh — the Codecov class: execute a remote script sight-unseen.', refusal: true, skipCommentLines: false, patterns: ['\\b(?:curl|wget)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?(?:ba|z|da|)sh\\b'] },
  { name: 'self-daemonize', scope: 'bash', teach: 'detached background self-spawn (nohup/disown/setsid &) — the ua-parser-js persistence class.', refusal: true, skipCommentLines: false, patterns: ['\\b(?:nohup|setsid)\\b[^\\n]+&\\s*$|\\bdisown\\b'] },
  { name: 'cron-persist', scope: 'bash', teach: 'crontab install from a file — establishes scheduled persistence.', refusal: true, skipCommentLines: false, patterns: ['\\bcrontab\\s+(?!-l\\b)[^\\n]*\\b(?:-|[^\\s]+)\\b'] },
  { name: 'systemd-persist', scope: 'bash', teach: 'write into a systemd unit dir or enable a freshly-dropped unit — persistence.', refusal: true, skipCommentLines: false, patterns: ['(?:\\/etc\\/systemd\\/system|\\/etc\\/init\\.d|~?\\/\\.config\\/systemd\\/user)\\/[^\\s]+|systemctl\\s+enable\\b'] },
  { name: 'systemd-persist', scope: 'edit', teach: 'write into a systemd unit dir or enable a freshly-dropped unit — persistence.', refusal: true, skipCommentLines: false, pathPattern: '(?:\\/etc\\/systemd\\/system|\\/etc\\/init\\.d|\\/\\.config\\/systemd\\/user)\\/[^\\s]+', patterns: ['^.*$'] },
  { name: 'autostart-persist', scope: 'bash', teach: 'write into an XDG autostart / login-item dir — the xz-utils persistence class.', refusal: true, skipCommentLines: false, patterns: ['(?:\\.config\\/autostart|Library\\/LaunchAgents|Library\\/LaunchDaemons)\\/[^\\s]+\\.(?:desktop|plist)\\b'] },
  { name: 'autostart-persist', scope: 'edit', teach: 'write into an XDG autostart / login-item dir — the xz-utils persistence class.', refusal: true, skipCommentLines: false, pathPattern: '(?:\\.config\\/autostart|Library\\/LaunchAgents|Library\\/LaunchDaemons)\\/[^\\s]+\\.(?:desktop|plist)$', patterns: ['^.*$'] },
  { name: 'git-config-global', scope: 'bash', teach: 'git config --global/--system mutates config outside the repo (can redirect URLs, set filters).', refusal: true, skipCommentLines: false, outsideQuotes: true, patterns: [
    '\\bgit\\s+config\\s+(?:--global|--system)\\b(?![^\\n;|&]*\\s(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)\\b)[^\\n;|&]*\\s(?:--add\\s+|--unset\\s+)?[^\\s-][^\\n;|&]*\\s[^\\s;|&]+',
    '\\bgit\\s+config\\b[^\\n;|&]*\\s--(?:global|system)\\b[^\\n;|&]*\\s(?:--(?:add|unset|unset-all|replace-all|remove-section|rename-section|edit)|-e)\\b',
    '\\bgit\\s+config\\b[^\\n;|&]*\\s(?:--(?:add|unset|unset-all|replace-all|remove-section|rename-section|edit)|-e)\\b[^\\n;|&]*\\s--(?:global|system)\\b',
    '\\bgit\\s+config\\s+(?:set|unset|edit|remove-section|rename-section)\\b[^\\n;|&]*\\s--(?:global|system)\\b',
  ] },
  { name: 'git-hooks-path', scope: 'bash', teach: 'setting core.hooksPath redirects git hooks to an untrusted directory (a bare read stays clear).', refusal: true, skipCommentLines: false, outsideQuotes: true, patterns: [
    '\\bgit\\s+config\\b(?![^\\n;|&]*\\s(?:--get|--get-all|--get-regexp|--list|-l)\\b)(?:[^\\n;|&]*\\s(?:--add|--unset|--unset-all|--replace-all|--edit|--file)\\b[^\\n;|&]*\\bcore\\.hooksPath\\b|[^\\n;|&]*\\bcore\\.hooksPath[^\\S\\n]+(?!\\d*[<>])[^\\s<>|&;)]+)',
    '\\bgit\\s+config\\s+(?:set|unset)\\b[^\\n;|&]*\\bcore\\.hooksPath\\b',
  ] },
  { name: 'git-internals-write', scope: 'bash', teach: 'direct write into .git/config or .git/hooks — installs a hook or rewrites config under the radar.', refusal: true, skipCommentLines: false, patterns: ['(?:^|[\\s>|;&])(?:>>?|tee|cp|mv|install|ln)\\b[^\\n]*\\.git\\/(?:config\\b|hooks\\/)'] },
  { name: 'no-sudo', scope: 'bash', teach: 'Privilege escalation (sudo, doas, pkexec) never runs from a session; a root command is the operator\'s to run by hand.', refusal: true, skipCommentLines: false, outsideQuotes: true, patterns: [CMD_START + '(?:(?:env|nice|nohup|time|command|builtin|exec|eval|xargs|timeout|stdbuf)(?:\\s+-\\S+)*(?:\\s+\\w+=\\S*)*\\s+)*(?:sudo|doas|pkexec)' + WORD_END] },
  { name: 'no-device-write', scope: 'bash', teach: 'A raw write to a device node (dd of=/dev/…, a redirect into a disk) overwrites a disk sight-unseen.', refusal: true, skipCommentLines: false, patterns: ['\\bdd\\b[^\\n;|&]*\\bof=["\']?\\/dev\\/(?!null\\b|zero\\b|full\\b|random\\b|urandom\\b|stdout\\b|stderr\\b|stdin\\b|tty|fd\\/|shm\\/)', '>\\s*["\']?\\/dev\\/(?:r?disk\\d|sd[a-z]|hd[a-z]|nvme\\d|mmcblk\\d|vd[a-z]|xvd[a-z]|loop\\d|dm-\\d|md\\d)'] },
  { name: 'no-disk-format', scope: 'bash', teach: 'Formatting or repartitioning a disk (mkfs, fdisk, parted, diskutil erase, format) destroys everything on it.', refusal: true, skipCommentLines: false, outsideQuotes: true, patterns: [CMD_START + '(?:mkfs(?:\\.[a-z0-9]+)?' + WORD_END + '|(?:mke2fs|mkswap|wipefs|cfdisk|sgdisk)' + WORD_END + '|(?:fdisk|sfdisk|gdisk)(?!\\s+-l\\b)' + WORD_END + '|parted(?!\\s+(?:-l|--list|print)\\b)' + WORD_END + '|diskutil\\s+(?:erase\\w*|partitionDisk|zeroDisk|randomDisk|secureErase|reformat|apfs\\s+(?:deleteContainer|eraseVolume|deleteVolume))\\b|format(?:\\.com)?\\s+[A-Za-z]:|(?:Format-Volume|Clear-Disk|Initialize-Disk)\\b)'] },
  { name: 'no-system-halt', scope: 'bash', teach: 'Shutting down, rebooting or halting the machine ends every session on it, the operator\'s included.', refusal: true, skipCommentLines: false, outsideQuotes: true, patterns: [CMD_START + '(?:(?:shutdown|reboot|halt|poweroff)' + WORD_END + '|(?:init|telinit)\\s+[06]\\b|systemctl\\s+(?:poweroff|reboot|halt|kexec)\\b|(?:Stop-Computer|Restart-Computer)\\b)'] },
  { name: 'no-fork-bomb', scope: 'bash', teach: 'A process that forks itself without bound takes the machine down.', refusal: true, skipCommentLines: false, patterns: ['(:|\\w+)\\s*\\(\\s*\\)\\s*\\{\\s*\\1\\s*\\|\\s*\\1\\s*&', 'function\\s+(\\w+)\\s*\\{\\s*\\1\\s*\\|\\s*\\1\\s*&', '\\bfork\\s+while\\s+fork\\b'] },
  { name: 'no-root-recursive-delete', scope: 'bash', teach: 'A recursive delete of the filesystem root, the home directory or a system directory destroys the machine or the operator\'s files; delete inside the project, a worktree or a scratch directory instead.', refusal: true, skipCommentLines: false, patterns: [
    '\\brm\\b(?=[^\\n;|&]*\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*\\b|--recursive\\b))[^\\n;|&]*\\s["\']?(?:\\/(?:\\*|\\s|$|["\'])|~(?:\\/\\*?)?(?:\\s|$|["\'])|\\$\\{?HOME\\}?(?:\\/\\*?)?(?:\\s|$|["\'])|\\/(?:Users|home)(?:\\/[^\\/\\s"\']+)?\\/?\\*?(?:\\s|$|["\'])|\\/root\\/?\\*?(?:\\s|$|["\'])|\\/(?:etc|usr|bin|sbin|lib|lib64|opt|boot|dev|proc|sys|System|Library|Applications|cores)(?:\\/[^\\s"\']*)?(?:\\s|$|["\'])|\\/var(?!\\/(?:tmp|folders)\\/)(?:\\/[^\\s"\']*)?(?:\\s|$|["\'])|\\/private(?!\\/(?:tmp|var\\/(?:tmp|folders))\\/)(?:\\/[^\\s"\']*)?(?:\\s|$|["\'])|\\/Volumes(?:\\/[^\\/\\s"\']+)?\\/?\\*?(?:\\s|$|["\']))',
    '\\b(?:rd|rmdir)\\s+\\/s\\b[^\\n;|&]*\\s["\']?[A-Za-z]:\\\\?["\']?(?:\\s|$)',
    '\\bRemove-Item\\b[^\\n;|&]*-Recurse[^\\n;|&]*\\s["\']?[A-Za-z]:\\\\?["\']?(?:\\s|$)',
  ] },
]

function blankQuotedRuns(text: string): string {
  let out = ''
  let quote: '' | "'" | '"' = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote === '') {
      out += ch
      if (ch === "'" || ch === '"') quote = ch
    } else if (quote === '"') {
      if (ch === '\\' && i + 1 < text.length) {
        i++
        continue
      }
      if (ch === '"') {
        out += ch
        quote = ''
      }
    } else if (ch === "'") {
      out += ch
      quote = ''
    }
  }
  return quote === '' ? out : text
}

function dropHeredocBodies(text: string): string {
  const out: string[] = []
  let terminator: string | null = null
  let dashed = false
  for (const line of text.split('\n')) {
    if (terminator !== null) {
      if ((dashed ? line.replace(/^\t+/, '') : line) === terminator) terminator = null
      continue
    }
    out.push(line)
    const m = /<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(line)
    if (m) {
      terminator = m[2] ?? m[3] ?? m[4] ?? null
      dashed = m[1] === '-'
    }
  }
  return out.join('\n')
}

function commandOutsideQuotes(command: string): string {
  return blankQuotedRuns(dropHeredocBodies(command))
}

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
  if (pending.shellCommand !== undefined) {
    return {
      scope: 'bash',
      path: '',
      text: pending.shellCommand,
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
  let words: string | undefined

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
    const text = rule.outsideQuotes === true && target.scope === 'bash' ? (words ??= commandOutsideQuotes(target.text)) : target.text
    const lines = text.split('\n')
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
  const closing =
    verdict.rule.refusal === true
      ? 'Do not rephrase the command to evade this rule — surface the refusal to the operator instead.'
      : 'This rule is mechanical: re-issuing the same content will be denied again; rewrite the call to comply.'
  return (
    `Ward '${verdict.rule.name}' blocked this ${toolName} call — matched ` +
    `"${verdict.excerpt}" (${verdict.target}:${verdict.line}). ${verdict.rule.teach} ${closing}`
  )
}
