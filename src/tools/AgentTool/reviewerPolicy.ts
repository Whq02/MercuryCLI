import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { whichSync } from '../../utils/which.js'
import { getCwd } from '../../utils/cwd.js'
import { commandWords } from '../../utils/hooks/generatedAssets.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import type { Tool, Tools } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { sectionHeadings } from '../FileEditTool/sectionEdit.js'

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

function verificationCommand(command: string, worktree: string, receipt: string): { command: string; lockRoot?: string } | null {
  const cd = /^cd\s+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)\s+&&\s+([\s\S]+)$/.exec(command)
  if (cd) {
    const directory = commandWords(`cd ${cd[1]}`)?.[1]
    try { if (!directory || realpathSync(resolve(worktree, directory)) !== worktree) return null } catch { return null }
    command = cd[2]!
  }
  const words = commandWords(command)
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
    const inner = verificationCommand(quote(args.slice(2)), worktree, receipt)
    if (inner === null || inner.lockRoot !== undefined) return null
    const base = /^BASE=(\/[^\s'"$`\\]+)$/m.exec(readFileSync(path, 'utf8'))?.[1]
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
  const bun = process.env.BUN || whichSync('bun')
  const environment = [`HOME=${home}`, `TMPDIR=${scratch}`, `MERCURY_CONFIG_DIR=${home}`, 'MERCURY_CREDENTIAL_STORE=file', `XDG_CACHE_HOME=${join(scratch, 'cache')}`, ...(bun ? [`BUN=${bun}`] : [])]
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

export function reviewerRefusal(tool: Tool, input: Record<string, unknown>, receipt: string, worktree: string): string | null {
  if (tool.name !== FILE_EDIT_TOOL_NAME) {
    if (tool.name === BASH_TOOL_NAME) {
      if (input._simulatedSedEdit !== undefined || input.dangerouslyDisableSandbox === true) return 'Reviewer commands cannot bypass their write protection.'
      if (typeof input.command === 'string' && verificationCommand(input.command, realpathSync(worktree), receipt) !== null) return null
    }
    return tool.isReadOnly(input) ? null : 'Reviewer tools allow read-only commands and confined bun/bash verification under scripts, not shell writes, Git mutations or arbitrary programs.'
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

export function restrictReviewerTools(tools: Tools, receiptPath: string, worktreePath: string): Tools {
  const receipt = realpathSync(resolve(receiptPath))
  const worktree = realpathSync(worktreePath)
  return tools.map(tool => ({
    ...tool,
    async call(...args: Parameters<Tool['call']>) {
      const refusal = reviewerRefusal(tool, args[0], receipt, worktree)
      if (refusal !== null) throw new Error(refusal)
      if (tool.name === FILE_EDIT_TOOL_NAME) args[0] = { ...args[0], file_path: receipt }
      const verification = tool.name === BASH_TOOL_NAME && typeof args[0].command === 'string'
        ? verificationCommand(args[0].command, worktree, receipt) : null
      if (verification === null) {
        if (tool.name === BASH_TOOL_NAME && !tool.isReadOnly(args[0])) throw new Error('Reviewer verification changed after admission; no command ran.')
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
