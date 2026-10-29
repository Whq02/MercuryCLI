import { randomUUID } from 'node:crypto'

import { validateUuid } from './uuid.js'


type ParsedSessionUrl = {
  sessionId: string
  jsonlFile: string | null
  isJsonlFile: boolean
}

export function parseSessionIdentifier(resumeIdentifier: string): ParsedSessionUrl | null {
  if (/\.jsonl$/i.test(resumeIdentifier)) {
    return {
      sessionId: randomUUID(),
      jsonlFile: resumeIdentifier,
      isJsonlFile: true,
    }
  }
  if (validateUuid(resumeIdentifier)) {
    return { sessionId: resumeIdentifier, jsonlFile: null, isJsonlFile: false }
  }
  return null
}
