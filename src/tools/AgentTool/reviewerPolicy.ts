import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { getCwd } from '../../utils/cwd.js'
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

function reviewSection(text: string, append: boolean): boolean {
  const headings = sectionHeadings(`${text}\n\n## Section boundary\n`).filter(row => row.level <= 2)
  const boundary = headings.pop()
  if (boundary?.heading !== '## Section boundary' || boundary.line !== text.split('\n').length + 2) return false
  return append ? headings.length === 0 : headings.length === 1 && headings[0]?.heading === '## Review' && text.trimStart().startsWith('## Review\n')
}

export function reviewerRefusal(tool: Tool, input: Record<string, unknown>, receipt: string): string | null {
  if (tool.name !== FILE_EDIT_TOOL_NAME) {
    return tool.isReadOnly(input) ? null : 'Reviewer tools cannot perform writes or execute commands that are not provably read-only.'
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

export function restrictReviewerTools(tools: Tools, receiptPath: string): Tools {
  const receipt = realpathSync(resolve(receiptPath))
  return tools.map(tool => ({
    ...tool,
    async call(...args: Parameters<Tool['call']>) {
      const refusal = reviewerRefusal(tool, args[0], receipt)
      if (refusal !== null) throw new Error(refusal)
      if (tool.name === FILE_EDIT_TOOL_NAME) args[0] = { ...args[0], file_path: receipt }
      return tool.call(...args)
    },
  }))
}
