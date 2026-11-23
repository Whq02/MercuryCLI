import { randomUUID } from 'crypto'
import type { AttachmentMessage } from '../../types/message.js'
import type { Attachment } from './types.js'

function queuedCommandSentAt(attachment: Attachment): string | undefined {
  if (attachment.type !== 'queued_command' || attachment.sentAt === undefined) {
    return undefined
  }
  return Number.isFinite(Date.parse(attachment.sentAt)) ? attachment.sentAt : undefined
}

function withDeliveredAt(
  attachment: Extract<Attachment, { type: 'queued_command' }>,
  deliveredAt: string,
): Attachment {
  return { ...attachment, deliveredAt }
}

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  const sentAt = queuedCommandSentAt(attachment)
  const delivered =
    sentAt !== undefined && attachment.type === 'queued_command'
      ? withDeliveredAt(attachment, new Date().toISOString())
      : attachment
  return {
    attachment: delivered,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: sentAt ?? new Date().toISOString(),
  }
}
