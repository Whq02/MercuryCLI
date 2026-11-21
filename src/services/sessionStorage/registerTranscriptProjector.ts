import {
  isTranscriptProjectorRegistered,
  registerTranscriptProjector,
  type TranscriptProjector,
} from '../../utils/sessionStorage/transcriptProjector.js'

function createDefaultTranscriptProjector(): TranscriptProjector {
  return {
    projectForTranscript(message, transcript = null) {
      const { projectForTranscript } =
        require('../desktop/screenshotRetention.js') as typeof import('../desktop/screenshotRetention.js')
      return projectForTranscript(message, transcript)
    },
    hasApiAttachment(attachment) {
      const { normalizeAttachmentForAPI } =
        require('../messages/attachmentText.js') as typeof import('../messages/attachmentText.js')
      return normalizeAttachmentForAPI(attachment).length > 0
    },
  }
}

export function registerDefaultTranscriptProjector(): void {
  if (isTranscriptProjectorRegistered()) return
  registerTranscriptProjector(createDefaultTranscriptProjector())
}
