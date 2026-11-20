import type { Message } from '../../types/message.js'
import type { Attachment } from '../../utils/attachments/types.js'

const REMOTE_FILES_NOTICE =
  "`ssh://host/path` is a file on another machine: Read, Edit, Write, Grep and Glob take it as a path. `host` is what `ssh host` accepts; `ssh://host/~/x` is under that account's home; Read of `ssh://` alone lists the hosts of the ssh configuration."

const REMOTE_WORD = /ssh:\/\/[^\s"'`<>)\]]*/gi

export function remoteFilesNotice(input: string, messages: readonly Message[] = []): Attachment[] {
  const named = (input.match(REMOTE_WORD) ?? []).some(word => !/^ssh:\/\/git@/i.test(word) && !/\.git[.,;:!?]*$/i.test(word))
  if (!named) return []
  const boundary = messages.findLastIndex(message => message.type === 'system' && message.subtype === 'compact_boundary')
  const told = messages
    .slice(boundary < 0 ? 0 : boundary)
    .some(message => message.type === 'attachment' && message.attachment.type === 'critical_system_reminder' && message.attachment.content === REMOTE_FILES_NOTICE)
  return told ? [] : [{ type: 'critical_system_reminder', content: REMOTE_FILES_NOTICE }]
}
