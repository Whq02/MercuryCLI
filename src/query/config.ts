import { getSessionId } from '../bootstrap/state.js'

export type QueryConfig = {
  sessionId: string
  gates: {
    emitToolUseSummaries: boolean
    isAnt: boolean
  }
}

export function buildQueryConfig(): QueryConfig {
  return {
    sessionId: String(getSessionId()),
    gates: {
      emitToolUseSummaries: false,
      isAnt: false,
    },
  }
}
