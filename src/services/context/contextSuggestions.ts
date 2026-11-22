import type { ContextData } from './analyzeContext.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type ContextSuggestion = Unbuilt

export function generateContextSuggestions(data: ContextData): ContextSuggestion[] {
  return notBuilt('src/services/context/contextSuggestions.ts:28')
}
