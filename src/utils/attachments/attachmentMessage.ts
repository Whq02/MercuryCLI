import { randomUUID } from 'crypto'
import type { AttachmentMessage } from '../../types/message.js'
import type { Attachment } from './types.js'

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    attachment: withDeliveryClock(attachment),
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: sentClockOf(attachment) ?? new Date().toISOString(),
  }
}

function sentClockOf(attachment: Attachment): string | null {
  if (attachment.type !== 'queued_command' || attachment.sentAt === undefined) return null
  return Number.isFinite(Date.parse(attachment.sentAt)) ? attachment.sentAt : null
}

function withDeliveryClock(attachment: Attachment): Attachment {
  if (attachment.type !== 'queued_command' || sentClockOf(attachment) === null) return attachment
  return { ...attachment, deliveredAt: new Date().toISOString() }
}
