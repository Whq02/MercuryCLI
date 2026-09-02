import { randomUUID } from 'node:crypto'

import { validateUuid } from './uuid.js'


export type ParsedSessionUrl = {
  sessionId: string
  ingressUrl: string | null
  isUrl: boolean
  jsonlFile: string | null
  isJsonlFile: boolean
}

export function parseSessionIdentifier(resumeIdentifier: string): ParsedSessionUrl | null {
  if (/\.jsonl$/i.test(resumeIdentifier)) {
    return {
      sessionId: randomUUID(),
      ingressUrl: null,
      isUrl: false,
      jsonlFile: resumeIdentifier,
      isJsonlFile: true,
    }
  }
  if (validateUuid(resumeIdentifier)) {
    return { sessionId: resumeIdentifier, ingressUrl: null, isUrl: false, jsonlFile: null, isJsonlFile: false }
  }
  try {
    new URL(resumeIdentifier)
    return { sessionId: randomUUID(), ingressUrl: resumeIdentifier, isUrl: true, jsonlFile: null, isJsonlFile: false }
  } catch {
    return null
  }
}
