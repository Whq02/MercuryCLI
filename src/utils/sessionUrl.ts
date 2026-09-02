import { randomUUID } from 'node:crypto'

import { validateUuid } from './uuid.js'

/**
 * Classifies a resume identifier as a transcript file, a session id, or an
 * ingress URL. The transcript-file check runs BEFORE URL parsing: a URL
 * parser reads a Windows drive letter as a scheme, so `C:\...\x.jsonl`
 * would otherwise classify as a URL.
 */

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
    // The ENTIRE URL is the ingress URL; the session id is fresh.
    return { sessionId: randomUUID(), ingressUrl: resumeIdentifier, isUrl: true, jsonlFile: null, isJsonlFile: false }
  } catch {
    return null
  }
}
