import type { Message } from '../../engine/message-shapes/message.js'
import type { Attachment } from '../../engine/attachment-shapes/attachmentTypes.js'

export interface TranscriptProjector {
  projectForTranscript<M extends Message>(message: M, transcript?: readonly Message[] | null): M
  hasApiAttachment(attachment: Attachment): boolean
}

let registered: TranscriptProjector | undefined

export function registerTranscriptProjector(projector: TranscriptProjector): void {
  registered = projector
}

export function isTranscriptProjectorRegistered(): boolean {
  return registered !== undefined
}

export function transcriptProjector(): TranscriptProjector {
  if (registered === undefined) {
    throw new Error('transcript projector is not registered: call registerBootDoors() at startup')
  }
  return registered
}
