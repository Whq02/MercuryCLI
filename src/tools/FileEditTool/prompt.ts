import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

/**
 * The Edit tool's model-facing usage text. The short description is a
 * one-line blurb owned by the tool file; everything here is the prompt.
 */

/** The steering bullet; empty when the owner is off or fails to load. */
function steeringBullet(): string {
  try {
    const { editSteeringLine } =
      require('../../services/projectIntel/steering.js') as typeof import('../../services/projectIntel/steering.js')
    const line = editSteeringLine()
    return line ? `\n- ${line}` : ''
  } catch {
    return ''
  }
}

export function getEditToolDescription(): string {
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
- \`replace_all\` swaps every occurrence of \`old_string\` in one call — the right tool for bulk substitutions, such as renaming an identifier throughout the file.${steeringBullet()}`
}
