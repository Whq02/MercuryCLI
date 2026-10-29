import { getSessionId } from '../bootstrap/state.js'
import { generateWordSlug } from './words.js'


const slugBySession = new Map<string, string>()

export function getPlanSlug(sessionId: string = getSessionId()): string {
  const cached = slugBySession.get(sessionId)
  if (cached) return cached
  const slug = generateWordSlug()
  slugBySession.set(sessionId, slug)
  return slug
}
