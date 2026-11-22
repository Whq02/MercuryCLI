import type { AppState } from '../../../state/AppState.js'
import { notBuilt } from '../../../pi/holes.js'

export type UrlElicitation = { mode: 'url'; url: string; elicitationId: string; message: string }

export function parseUrlElicitations(error: unknown): UrlElicitation[] {
  return notBuilt('src/services/mcp/client/urlElicitation.ts:5')
}

export function queueUrlElicitation(
  serverName: string,
  elicitation: UrlElicitation,
  signal: AbortSignal,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): Promise<'accept' | 'decline' | 'cancel'> {
  return notBuilt('src/services/mcp/client/urlElicitation.ts:20')
}
