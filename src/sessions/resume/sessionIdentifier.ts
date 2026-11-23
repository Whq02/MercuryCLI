import { randomUUID, type UUID } from 'node:crypto'

import { validateUuid } from '../../platform/primitives/uuid.js'

type ParsedSessionIdentifier = {
  sessionId: UUID
  jsonlFile: string | null
  isJsonlFile: boolean
}

export function parseSessionIdentifier(resumeIdentifier: string): ParsedSessionIdentifier | null {
  if (resumeIdentifier.toLowerCase().endsWith('.jsonl')) {
    return {
      sessionId: randomUUID(),
      jsonlFile: resumeIdentifier,
      isJsonlFile: true,
    }
  }

  const validUuid = validateUuid(resumeIdentifier)
  if (validUuid !== null) {
    return {
      sessionId: validUuid,
      jsonlFile: null,
      isJsonlFile: false,
    }
  }

  return null
}
