import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { whichSync } from '../../utils/which.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { resolveShellCwd } from '../../utils/Shell.js'
import { gitArgs, gitSubcommandIndex } from '../../utils/git/spawnArgs.js'
import { parseForSecurity, checkSemantics, extractShellCScript, preparedCommandRoot, preparedSecurityParse, prepareShellCScripts, shellCommandText, withBashParseScope, SHELL_C_MAX_DEPTH, type Node } from '../../utils/permissions/decision/commandAnalysis.js'
import { boxLockDirOfScript } from '../../utils/boxLock.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { rewriteReadOnlyGitCommand } from '../BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import type { Tool, Tools } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { sectionHeadings } from '../FileEditTool/sectionEdit.js'

export const REVIEW_BRIEF = `You are reviewing one committed change for Mercury, on frozen inputs. Find what the author missed, with evidence, and record it where the next reader looks.

## Your inputs
- The reviewed commit: your working directory is detached at that commit (frozen). Read \`git show --stat HEAD\`, then the diff.
- The job: the document the caller names, stating the objective and rules. Read it whole.
- The receipt: the author's account at the caller-named path. Read it whole; treat every claim as unverified until checked.
- Any named rules document (handbook or project laws): read it and hold the change to it.

## What you do
- Run verification yourself in the frozen worktree: bun scripts under \`scripts\`, bash suite runners, and \`bun run typecheck\` (optional \`with-box-lock.sh\` wrapper with a literal temporary \`BASE\`). Verification runs with a fresh temp home and filesystem confinement (worktree and receipt read-only; temp results writable; shell writes, Git mutations, installs, inline code and escaping paths refused; normal permissions still apply). If confinement is unavailable, no command runs — report that limit rather than claiming a pass. State what you ran versus only read.
- Check same-commit obligations: env registry rows, export inventory records, regenerated assets, and no person, session, method word or machine path in tracked text.
- Try to break it: untested boundaries, un-updated callers, proofs that cannot go red. Prefer a short list of evidenced findings to a long list of doubts.

## Your one write
Write findings only under \`## Review\` in the receipt: Edit with \`section: "## Review"\` and \`new_string\` when the heading exists, or \`append\` when absent. One bullet per finding: file and line, fault, command and output that showed it, and proposed fix (or one line when clean). Edit no other file or section.

## Your report
Summarize findings briefly, list proofs run with exit codes, and end with \`REVIEW: CLEAN\` or \`REVIEW: FINDINGS <count>\` — nothing after it.`

export function canonicalReviewerReceipt(path: string, worktree: string): string {
  if (!isAbsolute(path)) throw new Error('review_receipt must be an absolute path')
  const receipt = realpathSync(path)
  const within = relative(realpathSync(worktree), receipt)
  if (within === '' || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within))) throw new Error('The review receipt must be outside the frozen worktree')
  if (!statSync(receipt).isFile() || extname(receipt).toLowerCase() !== '.md') throw new Error('The review receipt must be an existing Markdown file')
  return receipt
}

function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}

async function commandWords(command: string): Promise<string[] | null> {
  const parsed = await parseForSecurity(command)
  if (parsed.kind !== 'simple' || parsed.commands.length !== 1 || !checkSemantics(parsed.commands).ok) return null
  const simple = parsed.commands[0]!
  return simple.redirects.length || simple.envVars.length ? null : simple.argv
}

async function verificationCommand(command: string, worktree: string, receipt: string): Promise<{ command: string; lockRoot?: string } | null> {
  const cd = /^cd\s+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)\s+&&\s+([\s\S]+)$/.exec(command)
  if (cd) {
    const directory = (await commandWords(`cd ${cd[1]}`))?.[1]
    try { if (!directory || realpathSync(resolve(worktree, directory)) !== worktree) return null } catch { return null }
    command = cd[2]!
  }
  const words = await commandWords(command)
  if (!words?.length) return null
  const executable = basename(words[0]!).replace(/\.exe$/i, '')
  if (executable !== 'bun' && executable !== 'bash') return null
  const args = words.slice(1)
  if (executable === 'bun' && args[0] === 'run') args.shift()
  if (executable === 'bun' && args.length === 1 && args[0] === 'typecheck') return { command }
  const program = args[0]
  if (!program || program.startsWith('-')) return null
  let path: string
  try { path = realpathSync(resolve(worktree, program)); if (!statSync(path).isFile()) return null } catch { return null }
  if (executable === 'bash' && basename(path) === 'with-box-lock.sh') {
    if (!args[1] || !/^[A-Za-z0-9_.-]+$/.test(args[1])) return null
    const inner = await verificationCommand(quote(args.slice(2)), worktree, receipt)
    if (inner === null || inner.lockRoot !== undefined) return null
    const base = boxLockDirOfScript(path)
    if (!base) return null
    let lockRoot: string
    try { lockRoot = realpathSync(base) } catch { return null }
    const temporary = [realpathSync(tmpdir()), ...(process.platform === 'win32' ? [] : [realpathSync('/tmp')])]
    if (!temporary.some(root => lockRoot !== root && within(root, lockRoot)) || within(lockRoot, worktree) || within(worktree, lockRoot) || within(lockRoot, receipt)) return null
    return { command, lockRoot }
  }
  if (!within(join(worktree, 'scripts'), path)) return null
  if (executable === 'bun' ? !/\.(?:ts|tsx|js|mjs)$/.test(path) : extname(path) !== '.sh') return null
  return { command }
}

function confinedVerification(command: string, worktree: string, receipt: string, scratch: string, lockRoot: string | undefined): string {
  const home = join(scratch, 'home')
  mkdirSync(home)
  const bun = flagEnv('MERCURY_BUN') || whichSync('bun')
  const environment = [`HOME=${home}`, `TMPDIR=${scratch}`, `MERCURY_CONFIG_DIR=${home}`, 'MERCURY_CREDENTIAL_STORE=file', `XDG_CACHE_HOME=${join(scratch, 'cache')}`, ...(bun ? [`MERCURY_BUN=${bun}`, `BUN=${bun}`] : [])]
  if (process.platform === 'darwin') {
    const bin = join(scratch, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'mktemp'), '#!/bin/sh\nexec /usr/bin/mktemp -p "${TMPDIR:?}" "$@"\n', { mode: 0o700 })
    environment.push(`PATH=${bin}:${process.env.PATH ?? ''}`)
  }
  const inner = `cd ${quote([worktree])} && env ${quote(environment)} ${command}`
  const writeConfig = { allowOnly: [scratch, ...(lockRoot ? [lockRoot] : []), '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'], denyWithinAllow: [worktree, receipt] }
  if (process.platform === 'darwin') {
    const profilePath = join(scratch, 'filesystem.sb')
    writeConfig.denyWithinAllow.push(profilePath)
    const profile = ['(version 1)', '(allow default)', '(deny file-write*)', '(deny file-link)',
      `(allow file-write* ${writeConfig.allowOnly.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')})`,
      `(deny file-write* ${writeConfig.denyWithinAllow.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')})`,
    ].join('\n')
    writeFileSync(profilePath, profile, { mode: 0o600 })
    return quote(['/usr/bin/sandbox-exec', '-f', profilePath, '/bin/bash', '-c', inner])
  }
  if (process.platform === 'linux') {
    const bwrap = whichSync('bwrap')
    if (bwrap === null) throw new Error('Reviewer verification needs filesystem confinement: bubblewrap is unavailable; no command ran.')
    return quote([bwrap, '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', scratch, scratch, ...(lockRoot ? ['--bind', lockRoot, lockRoot] : []), '--chdir', worktree, '--', '/bin/bash', '-c', inner])
  }
  throw new Error('Reviewer verification needs filesystem confinement, unavailable on this platform; no command ran.')
}

function reviewSection(text: string, append: boolean): boolean {
  const headings = sectionHeadings(`${text}\n\n## Section boundary\n`).filter(row => row.level <= 2)
  const boundary = headings.pop()
  if (boundary?.heading !== '## Section boundary' || boundary.line !== text.split('\n').length + 2) return false
  return append ? headings.length === 0 : headings.length === 1 && headings[0]?.heading === '## Review' && text.trimStart().startsWith('## Review\n')
}

const GIT_READ_INSERTS = new Set(['--stat', '--no-ext-diff', '--no-textconv'])

function plainGitArgs(hardened: string[], cwd: string, text: string): string[] | null {
  const base = gitArgs([], cwd)
  if (base.length === 0 || base.some((word, index) => hardened[index] !== word)) return null
  for (let own = base.length; ; own += 2) {
    const rest = hardened.slice(own)
    const after = gitSubcommandIndex(rest) + 1
    const inserted = [after, after + 1, after + 2, after + 3].filter(index => GIT_READ_INSERTS.has(rest[index] ?? ''))
    for (let taken = (1 << inserted.length) - 1; taken >= 0; taken--) {
      const plain = rest.filter((_, index) => !inserted.some((position, bit) => position === index && (taken & (1 << bit)) !== 0))
      if (shellCommandText(['git', ...gitArgs(plain, cwd)]) === text) return plain
    }
    if (hardened[own] !== '-c') return null
  }
}

function plainGitSpelling(command: string, cwd: string, depth = 0): string {
  if (depth > SHELL_C_MAX_DEPTH) return command
  const root = preparedCommandRoot(command)
  if (!root || root.type === 'ERROR') return command
  const spans: Array<{ start: number; end: number; text: string }> = []
  const visit = (node: Node): void => {
    if (node.type === 'command') {
      const parsed = preparedSecurityParse(node.text)
      const simple = parsed.kind === 'simple' && parsed.commands.length === 1 ? parsed.commands[0] : undefined
      if (simple?.argv[0] === 'git') {
        const plain = plainGitArgs(simple.argv.slice(1), cwd, node.text)
        if (plain !== null) spans.push({ start: node.startIndex, end: node.endIndex, text: shellCommandText(['git', ...plain]) })
      } else if (simple) {
        const script = extractShellCScript(simple)
        const plain = script === null ? null : plainGitSpelling(script, cwd, depth + 1)
        if (plain !== null && plain !== script) spans.push({ start: node.startIndex, end: node.endIndex, text: shellCommandText([simple.argv[0] as string, simple.argv[1] as string, plain]) })
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(root)
  let plain = command
  for (const span of spans.sort((a, b) => b.start - a.start)) plain = plain.slice(0, span.start) + span.text + plain.slice(span.end)
  return plain
}

export async function hardenedGitRead(tool: Tool, input: Record<string, unknown>): Promise<boolean> {
  const given = input.command
  if (tool.name !== BASH_TOOL_NAME || typeof given !== 'string') return false
  return withBashParseScope(async () => {
    await prepareShellCScripts(await parseForSecurity(given))
    const cwd = resolveShellCwd(typeof input.cwd === 'string' ? input.cwd : undefined)
    const plain = { ...input, command: plainGitSpelling(given, cwd) }
    if (plain.command === given) return false
    await tool.prepare?.(plain)
    return tool.isReadOnly(plain) && rewriteReadOnlyGitCommand(plain.command, cwd) === given
  })
}

export async function reviewerRefusal(tool: Tool, input: Record<string, unknown>, receipt: string, worktree: string, atCall = false): Promise<string | null> {
  if (tool.name === BASH_TOOL_NAME) await tool.prepare?.(input)
  if (tool.name !== FILE_EDIT_TOOL_NAME) {
    if (tool.name === BASH_TOOL_NAME) {
      if (input._simulatedSedEdit !== undefined) return 'Reviewer commands cannot bypass their write protection.'
      if (typeof input.command === 'string' && await verificationCommand(input.command, realpathSync(worktree), receipt) !== null) return null
    }
    return tool.isReadOnly(input) || (atCall && await hardenedGitRead(tool, input)) ? null : 'Reviewer tools allow read-only commands and confined bun/bash verification under scripts, not shell writes, Git mutations or arbitrary programs.'
  }
  if (typeof input.file_path !== 'string') return 'The reviewer edit must name its declared receipt.'
  try {
    if (realpathSync(resolve(getCwd(), input.file_path)) !== receipt) return 'The reviewer may edit only its declared receipt.'
  } catch {
    return 'The declared receipt must be an existing file.'
  }
  if (input.old_string !== undefined || input.hunks !== undefined || input.replace_all === true) return 'Reviewer edits must use the Review section, not whole-file or range replacement.'
  if (input.section === '## Review') {
    if (typeof input.append === 'string' && reviewSection(input.append, true)) return null
    if (typeof input.new_string === 'string' && reviewSection(input.new_string, false)) return null
    return 'Reviewer content must stay inside the Review section.'
  }
  if (input.section === undefined && typeof input.append === 'string' && reviewSection(input.append, false)) {
    const current = readFileSync(receipt, 'utf8')
    if (!sectionHeadings(current).some(row => row.heading === '## Review')) return null
  }
  return 'The reviewer may only replace or append the Review section.'
}

function reviewerOffersTool(tool: Tool): boolean {
  if (tool.name === FILE_EDIT_TOOL_NAME || tool.name === BASH_TOOL_NAME) return true
  try {
    return tool.isReadOnly({} as never) === true
  } catch {
    return false
  }
}

export function restrictReviewerTools(tools: Tools, receiptPath: string, worktreePath: string): Tools {
  const receipt = realpathSync(resolve(receiptPath))
  const worktree = realpathSync(worktreePath)
  return tools.filter(reviewerOffersTool).map(tool => ({
    ...tool,
    async call(...args: Parameters<Tool['call']>) {
      const refusal = await reviewerRefusal(tool, args[0], receipt, worktree, true)
      if (refusal !== null) throw new Error(refusal)
      if (tool.name === FILE_EDIT_TOOL_NAME) args[0] = { ...args[0], file_path: receipt }
      const verification = tool.name === BASH_TOOL_NAME && typeof args[0].command === 'string'
        ? await verificationCommand(args[0].command, worktree, receipt) : null
      if (verification === null) {
        if (tool.name === BASH_TOOL_NAME && !tool.isReadOnly(args[0]) && !(await hardenedGitRead(tool, args[0]))) throw new Error('Reviewer verification changed after admission; no command ran.')
        return tool.call(...args)
      }
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-check-')))
      let background = false
      try {
        const command = confinedVerification(verification.command, worktree, receipt, scratch, verification.lockRoot)
        args[0] = { ...args[0], command }
        const result = await tool.call(...args)
        const id = (result.data as { backgroundTaskId?: string })?.backgroundTaskId
        background = id !== undefined
        if (id) {
          const task = args[1].getAppState().tasks[id] as { shellCommand?: { result: Promise<unknown> } } | undefined
          if (task?.shellCommand) void task.shellCommand.result.finally(() => rmSync(scratch, { recursive: true, force: true })).catch(() => {})
        }
        return result
      } finally {
        if (!background) rmSync(scratch, { recursive: true, force: true })
      }
    },
  }))
}
