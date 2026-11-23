import {
  isTranscriptProjectorRegistered,
  registerTranscriptProjector,
  type TranscriptProjector,
} from '../transcripts/transcriptProjector.js'

function createDefaultTranscriptProjector(): TranscriptProjector {
  return {
    projectForTranscript(message, transcript = null) {
      const { projectForTranscript } =
        require('../../integrations/desktop/screenshotRetention.js') as typeof import('../../integrations/desktop/screenshotRetention.js')
      return projectForTranscript(message, transcript)
    },
    hasApiAttachment(attachment) {
      const { normalizeAttachmentForAPI } =
        require('../../engine/messages/attachmentText.js') as typeof import('../../engine/messages/attachmentText.js')
      return normalizeAttachmentForAPI(attachment).length > 0
    },
  }
}

export function registerDefaultTranscriptProjector(): void {
  if (isTranscriptProjectorRegistered()) return
  registerTranscriptProjector(createDefaultTranscriptProjector())
}
