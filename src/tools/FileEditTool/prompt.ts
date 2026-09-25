import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'


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

export function getEditToolDescription(offered: ReadonlySet<string> | null = null): string {
  const prefixShape = isCompactLinePrefixEnabled()
    ? 'line number + tab'
    : 'spaces + line number + →'
  return `Swap one exact string for another inside a file.

Usage:
- An edit lands only after \`${FILE_READ_TOOL_NAME}\` has read the file somewhere in this conversation — editing unread files errors.
- When an edit's text comes from ${FILE_READ_TOOL_NAME} output, carry the indentation byte-for-byte (tabs/spaces) as it stands PAST the line-number prefix. The prefix shape is: ${prefixShape}. Real file content starts past that prefix — no fragment of the prefix ever belongs in old_string or new_string.
- Default to modifying files that already exist; creating a brand-new file needs an explicit reason from the task.
- Keep emoji out of file content unless the user has specifically asked for them.
- A non-unique \`old_string\` makes the edit fail outright: nothing changes until the match is unambiguous. Disambiguate by widening \`old_string\` with more of the surrounding lines, or pass \`replace_all\` to rewrite every occurrence at once.
- \`replace_all\` swaps every occurrence of \`old_string\` in one call — the right tool for bulk substitutions, such as renaming an identifier throughout the file.
- \`append\` adds text at the end of the file on its own line with no line arithmetic and no prior read (no existing byte changes); \`section\` names a Markdown heading line and, with \`new_string\`, replaces that whole section, or, with \`append\`, adds text inside it. A file's read knowledge is keyed to its content: a Read of the lines the edit touches, a content-mode Grep that displayed them, or \`expected_anchor\` from a full Read all count. A file you wrote with ${FILE_WRITE_TOOL_NAME} or changed with this tool in this conversation counts as read as it stands: no ${FILE_READ_TOOL_NAME} is needed before editing it again.
- An edit that touches lines you have not read still lands in one call when you have read the file as it stands and those lines fit a ${FILE_READ_TOOL_NAME} window: the result carries the edited lines as they now stand, numbered as ${FILE_READ_TOOL_NAME} shows them, with their anchor, and they count as read. A file you never read, a file that changed after your read, or a stale expected_anchor refuses instead; the refusal carries the lines the same way and its first sentence says what to do. Past a ${FILE_READ_TOOL_NAME} window's worth, the refusal names the ${FILE_READ_TOOL_NAME} that covers the rest.${steeringBullet(offered)}`
}
