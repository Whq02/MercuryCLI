/**
 * Builds the Bash tool's model-facing description: tool-preference steering,
 * instruction bullets, the sandbox restriction disclosure, and the git
 * commit/PR workflow. Plus two thin timeout accessors the tool schema uses.
 *
 * All prose here is Mercury's own; only the literal identifiers (flag names,
 * parameter names, environment variables) and the two prover-pinned substrings
 * are fixed.
 */
import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../../utils/timeouts.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { shouldIncludeGitInstructions } from '../../utils/gitSettings.js'
import { getAttributionTexts } from '../../utils/attribution.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getMercuryTempDir } from '../../utils/permissions/filesystem.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { BASH_TOOL_NAME } from './toolName.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../TodoWriteTool/constants.js'

// ── timeout accessors ──────────────────────────────────────────────────

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

// ── the description ─────────────────────────────────────────────────────

/** Build the Bash tool's model-facing description. Reads state/settings on every call. */
export function getSimplePrompt(): string {
  const embedded = hasEmbeddedSearchTools()
  const sections: string[] = []

  sections.push('Runs a shell command in the session bash and hands back its combined output (stdout and stderr interleaved).')
  sections.push(
    'Command output comes back to you, the model — the operator does not reliably see it. Anything they need from a command belongs in your reply.',
  )
  sections.push(
    'The working directory persists from call to call; every other piece of shell state (variables, functions, options) resets between calls. Each call starts from your profile (bash or zsh).',
  )

  // The named set to avoid; find/grep drop out when embedded search ships.
  const avoidSet = embedded
    ? ['cat', 'head', 'tail', 'sed', 'awk', 'echo']
    : ['find', 'grep', 'cat', 'head', 'tail', 'sed', 'awk', 'echo']
  sections.push(
    `Avoid running ${avoidSet.map(c => `\`${c}\``).join(', ')} through this tool unless you are explicitly asked to, or you have verified that no dedicated tool can do the job. A dedicated tool is a better experience.`,
  )

  const preferenceBullets: string[] = []
  if (!embedded) {
    preferenceBullets.push(`File search: use the ${GLOB_TOOL_NAME} tool, not \`find\` or \`ls\`.`)
    preferenceBullets.push(`Content search: ${GREP_TOOL_NAME} is the search path here — never shell \`grep\`/\`rg\`.`)
  }
  preferenceBullets.push(`Reading a file: ${FILE_READ_TOOL_NAME} owns it — never \`cat\`/\`head\`/\`tail\`.`)
  preferenceBullets.push(`Editing a file: ${FILE_EDIT_TOOL_NAME} owns it — never \`sed\`/\`awk\`.`)
  preferenceBullets.push(`Write files: use the ${FILE_WRITE_TOOL_NAME} tool, not \`echo >\` or a heredoc.`)
  preferenceBullets.push('Talking to the user: write it in your reply — an `echo`/`printf` reaches nobody.')
  sections.push(preferenceBullets.map(b => `- ${b}`).join('\n'))

  // The tool-preference closing line — carries the prover's positive-control substring.
  sections.push(
    "When a dedicated tool exists, it's the stronger path: purpose-built calls render better for the operator and are simpler to review and permission.",
  )

  sections.push(buildInstructions(embedded))

  // Concatenated unconditionally (empty when sandboxing off, leaving one blank line).
  sections.push(buildSandboxSection())

  // Only when git instructions are enabled; its blank separator is omitted when empty.
  const gitSection = buildGitSection()
  if (gitSection !== '') sections.push(gitSection)

  return sections.join('\n\n')
}

function minutes(ms: number): number {
  return Math.round(ms / 60000)
}

function buildInstructions(embedded: boolean): string {
  const maxMs = getMaxBashTimeoutMs()
  const defaultMs = getDefaultBashTimeoutMs()
  const bullets: string[] = [
    'Before creating a directory or file, `ls` the parent — confirm it exists and is the location you mean.',
    'A path with spaces travels double-quoted, always.',
    'Keep the working directory stable: absolute paths instead of `cd` (a `cd` is fine when the user asks for one).',
    `The optional \`timeout\` parameter takes a value in milliseconds, up to a maximum of ${maxMs} ms (${minutes(maxMs)} minutes); when omitted it defaults to ${defaultMs} ms (${minutes(defaultMs)} minutes).`,
  ]
  bullets.push(
    'Set `run_in_background: true` when the result can wait: the command detaches, you are notified on completion, there is no need to check its output right away, and no trailing `&` is required.',
  )
  bullets.push(
    'When issuing multiple commands:\n  - independent commands should be separate parallel tool calls in one message (for example, one call for `git status` and another for `git diff`);\n  - dependent commands should be one call chained with `&&`; use `;` only when an earlier failure does not matter;\n  - commands never separate on a bare newline (newlines WITHIN a quoted string are fine).',
  )
  bullets.push(
    'For git commands: prefer creating a new commit over amending; consider a safer alternative before any destructive operation (`git reset --hard`, `git push --force`, `git checkout --`); never skip hooks (`--no-verify`) or bypass signing (`--no-gpg-sign`, or an inline config disabling gpg signing) unless explicitly asked, and investigate a hook failure rather than working around it.',
  )
  bullets.push(
    'Avoid unnecessary sleeps: never sleep between commands that are ready to run; use `run_in_background` for long-running work rather than sleeping; diagnose a failing command instead of re-running it in a sleep-and-retry loop; do not poll a task started with `run_in_background`, since completion is notified; if an external process must be polled, use a status command (for example `gh run view <run-id>`) rather than sleeping first; and if a sleep is truly unavoidable, keep it to roughly 1-5 seconds so the user is not blocked.',
  )
  bullets.push(
    'To drive a web page — click, type, wait for an element, read rendered text or console errors, screenshot — use the `Browser` tool (when deferred, load it with ToolSearch `select:Browser`). Never hand-roll a headless-Chrome harness or install a browser driver (`npm i puppeteer`, `npx playwright install`) for a one-off check; the driver is bundled and already resolved.',
  )
  if (embedded) {
    bullets.push(
      "The embedded `find` implementation's `-regex` uses leftmost-first alternation (unlike GNU find's leftmost-longest), so list the longest alternative first: prefer `'.*\\.tsx?'` written as `.tsx|.ts`, not `.ts|.tsx`.",
    )
  }
  return `# Instructions\n${bullets.map(b => `- ${b}`).join('\n')}`
}

function buildSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) return ''
  const unsandboxedAllowed = SandboxManager.areUnsandboxedCommandsAllowed()
  const lines: string[] = ['# Command sandbox']
  lines.push(
    'Commands run in a sandbox by default: it bounds which directories and network hosts a command can touch or change unless explicitly overridden.',
  )
  lines.push('The active restrictions are:')

  const fsWrite = SandboxManager.getFsWriteConfig()
  const fsRead = SandboxManager.getFsReadConfig()
  const tempDir = getMercuryTempDir()
  const filesystem: Record<string, unknown> = {
    read: fsRead.allowWithinDeny
      ? { denyOnly: dedupe(fsRead.denyOnly), allowWithinDeny: dedupe(fsRead.allowWithinDeny) }
      : { denyOnly: dedupe(fsRead.denyOnly) },
    write: {
      allowOnly: dedupeAndNormaliseTemp(fsWrite.allowOnly, tempDir),
      denyWithinAllow: dedupe(fsWrite.denyWithinAllow),
    },
  }
  lines.push(`- Filesystem: ${jsonStringify(filesystem)}`)

  const network = SandboxManager.getNetworkRestrictionConfig()
  const sockets = SandboxManager.getAllowUnixSockets()
  const networkObject: Record<string, unknown> = {}
  if (network.allowedHosts && network.allowedHosts.length > 0) networkObject.allowedHosts = dedupe(network.allowedHosts)
  if (network.deniedHosts && network.deniedHosts.length > 0) networkObject.deniedHosts = dedupe(network.deniedHosts)
  if (sockets && sockets.length > 0) networkObject.allowedUnixSockets = dedupe(sockets)
  if (Object.keys(networkObject).length > 0) lines.push(`- Network: ${jsonStringify(networkObject)}`)

  const ignored = SandboxManager.getIgnoreViolations()
  if (ignored) lines.push(`- Ignored violations: ${jsonStringify(ignored)}`)

  if (unsandboxedAllowed) {
    lines.push(
      '- Default to running inside the sandbox. Reach for `dangerouslyDisableSandbox: true` only when the user has asked outright for an unsandboxed run, or when a specific command just failed with evidence pointing at a sandbox restriction (most failures have nothing to do with the sandbox).',
    )
    lines.push(
      '- Evidence of a sandbox restriction: an operation-not-permitted error on a file or network operation; access denied to a path outside the allowed directories; a connection failure to a non-allowlisted host; or a unix-socket connection error.',
    )
    lines.push(
      '- On such evidence, retry immediately with the override, without asking; briefly explain which restriction likely caused the failure and mention that the `/sandbox` command manages restrictions, and say that the override raises a permission prompt.',
    )
    lines.push('- Treat each overridden command individually; a recent override does not carry forward.')
    lines.push(
      '- Never suggest adding sensitive paths to the sandbox allowlist (`~/.bashrc`, `~/.zshrc`, `~/.ssh/*`, credential files).',
    )
  } else {
    lines.push('- Every command here runs sandboxed; policy has switched the `dangerouslyDisableSandbox` parameter off.')
    lines.push('- There is no circumstance in which a command runs outside the sandbox.')
    lines.push('- Resolve a sandbox-caused failure by adjusting the sandbox settings with the user.')
  }
  lines.push(
    'Temporary files belong under `$TMPDIR` — it already points at the sandbox-writable temp directory; never spell /tmp paths yourself.',
  )
  return lines.join('\n')
}

function buildGitSection(): string {
  if (!shouldIncludeGitInstructions()) return ''
  const attribution = getAttributionTexts()
  const lines: string[] = []
  lines.push('# Committing changes with git')
  lines.push('Only create a commit when the user asks for one; if it is unclear, ask first.')
  lines.push(
    'You may issue several tool calls in one response; batch independent commands that are likely to succeed in parallel.',
  )
  lines.push(
    'Git safety protocol: never update git config; never run a destructive git command (`push --force`, `reset --hard`, `checkout .`, `restore .`, `clean -f`, `branch -D`) unless explicitly asked; never bypass hooks (`--no-verify`, `--no-gpg-sign`); never force-push to `main`/`master`, and warn when asked to; amend only on an explicit request — otherwise every commit is a NEW one (after a failed pre-commit hook there IS no new commit, so an amend would rewrite the previous one and can destroy work); stage named files rather than the sweep-everything forms `git add -A`/`git add .`, which drag in secrets and large binaries; commit only when asked.',
  )
  lines.push(
    `Commit workflow: (1) in parallel, run \`git status\` (never with \`-uall\`, which can exhaust memory on large repos), a diff of staged and unstaged changes, and a log to learn the repository's message style, each through the ${BASH_TOOL_NAME} tool; (2) read every staged change and compose the message, choosing the verb correctly (add = wholly new, update = an enhancement, fix = a bug fix), avoiding likely-secret files (\`.env\`, \`credentials.json\`) and warning if the user asks for them, keeping the message to one or two sentences focused on WHY; (3) in parallel, stage the relevant untracked files and create the commit${attribution.commit ? ' with the attribution trailer appended' : ''}, then run \`git status\` sequentially after the commit to verify; (4) on a pre-commit hook failure, fix the problem and create a NEW commit.`,
  )
  lines.push(
    `Never run additional exploration commands beyond the git ones; never use the ${TODO_WRITE_TOOL_NAME} or ${AGENT_TOOL_NAME} tools here; do not push unless asked; never use git's interactive \`-i\` flag (rebase/add), since interactive input is unsupported; do not pass \`--no-edit\` to \`git rebase\`; nothing staged means no commit at all (never an empty one); the commit message always travels in a quoted heredoc.`,
  )
  if (attribution.commit) {
    lines.push('Worked example (heredoc form with the attribution trailer):\n```\ngit commit -m "$(cat <<\'EOF\'\nfix: correct the off-by-one in the parser\n\n' + attribution.commit + '\nEOF\n)"\n```')
  }
  lines.push('# Creating pull requests')
  lines.push(
    `Every GitHub task — issues, pull requests, checks, releases, resolving a GitHub URL — goes through \`gh\` run by the ${BASH_TOOL_NAME} tool.`,
  )
  lines.push(
    'PR workflow: (1) in parallel, run status (again never `-uall`), a diff, a check of whether the branch tracks a remote and is up to date, and both a log and a three-dot diff against the base branch to see the whole branch history; (2) read every commit the PR will carry, not only the newest, and draft a title under 70 characters with the detail in the body; (3) in parallel, create the branch if needed, push with `-u` if needed, and create the PR with `gh pr create` using a heredoc body.',
  )
  lines.push(
    'Worked example (PR body):\n```\ngh pr create --title "Fix the parser off-by-one" --body "$(cat <<\'EOF\'\n## Summary\n- corrects the boundary in the token walk\n- adds a regression test\n\n## Test plan\n- [ ] unit tests pass\n- [ ] manual check on the sample corpus' + (attribution.pr ? '\n\n' + attribution.pr : '') + '\nEOF\n)"\n```',
  )
  lines.push(
    `The ${TODO_WRITE_TOOL_NAME} and ${AGENT_TOOL_NAME} tools stay out of this flow; finish by handing the user the PR URL to open.`,
  )
  lines.push(
    'Other common operations: view PR comments through `gh api repos/<owner>/<repo>/pulls/<number>/comments`.',
  )
  return lines.join('\n\n')
}

// ── sandbox-section helpers ────────────────────────────────────────────────────

/** De-duplicate preserving first-occurrence order; an absent/empty array passes through as-is. */
function dedupe(list: string[] | undefined): string[] | undefined {
  if (!list || list.length === 0) return list
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/** De-duplicate AND replace an entry equal to the per-user temp dir with `$TMPDIR`. */
function dedupeAndNormaliseTemp(list: string[] | undefined, tempDir: string): string[] | undefined {
  if (!list || list.length === 0) return list
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const value = item === tempDir ? '$TMPDIR' : item
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}
