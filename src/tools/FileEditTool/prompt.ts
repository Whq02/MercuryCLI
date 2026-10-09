import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'


const LOCAL_SPAN_REMEDY = `name the smallest unique span, or rewrite the file with ${FILE_WRITE_TOOL_NAME}`

export function localSpanRefusalMessage(share: number): string {
  return `old_string is ${share}% of the file — ${LOCAL_SPAN_REMEDY}`
}

function localSpanBullet(model: string | undefined): string {
  if (model === undefined || declaredRouteOf(model) !== 'local') return ''
  return `\n- On a locally served model an \`old_string\` over half the file (by bytes) is refused before any write — ${LOCAL_SPAN_REMEDY}.`
}

function steeringBullet(offered: ReadonlySet<string> | null): string {
  try {
    const { editSteeringLine } =
      require('../../services/projectIntel/steering.js') as typeof import('../../services/projectIntel/steering.js')
    const line = editSteeringLine(offered)
    return line ? `\n- ${line}` : ''
  } catch {
    return ''
  }
}

export function getEditToolDescription(offered: ReadonlySet<string> | null = null, model?: string): string {
  const prefixShape = 'line number + tab'
  return `Swap one exact string for another inside a file.

Usage:
- An edit lands only after \`${FILE_READ_TOOL_NAME}\` has read the file somewhere in this conversation — editing unread files errors.
- When an edit's text comes from ${FILE_READ_TOOL_NAME} output, carry the indentation byte-for-byte (tabs/spaces) as it stands past the line-number prefix. The prefix shape is: ${prefixShape}. Real file content starts past that prefix — no fragment of the prefix ever belongs in old_string or new_string.
- A non-unique \`old_string\` writes nothing; the error names and shows every match with its neighbouring lines: widen it with a line that differs, or pass \`replace_all\` to rewrite every occurrence at once (the right tool for bulk substitutions, such as renaming an identifier throughout the file).
- A landed edit shows the changed lines as read back after the write, numbered as ${FILE_READ_TOOL_NAME} numbers them, with three lines of context; they count as read, so checking the edit needs no ${FILE_READ_TOOL_NAME}.
- \`append\` adds text at the end of the file with no prior read; \`section\` names a Markdown heading line and, with \`new_string\`, replaces that whole section, or, with \`append\`, adds text inside it. A file's read knowledge is keyed to its content: a Read of the lines the edit touches, a content-mode Grep that displayed them, or \`expected_anchor\` from a full Read all count.
- An edit that touches lines you have not read still lands in one call when you have read the file as it stands and those lines fit a ${FILE_READ_TOOL_NAME} window; a file you never read, one that changed after your read, or a stale expected_anchor refuses instead, and the refusal's first sentence says what to do.${localSpanBullet(model)}${steeringBullet(offered)}`
}
