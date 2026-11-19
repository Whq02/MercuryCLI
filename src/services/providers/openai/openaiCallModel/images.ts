import {
  readPreferredOpenaiSource,
  type OpenaiAccountSourceKind,
} from '../openaiAccounts.js'
import {
  evaluateGptCandidate,
} from '../openaiCatalogue.js'
import { type OpenaiLiveModel } from '../openaiClient.js'

export function imagesSupportedForLiveModel(live: Pick<OpenaiLiveModel, 'inputModalities'> | undefined): boolean {
  return live?.inputModalities ? live.inputModalities.includes('image') : true
}

const OPENAI_SOURCE_KINDS: readonly OpenaiAccountSourceKind[] = ['chatgpt-subscription', 'api-key']

function imagesSupportedForModelId(model: string): boolean {
  const preferred = readPreferredOpenaiSource()
  const kinds = preferred ? [preferred, ...OPENAI_SOURCE_KINDS.filter(kind => kind !== preferred)] : OPENAI_SOURCE_KINDS
  for (const kind of kinds) {
    const evaluated = evaluateGptCandidate(model, kind)
    if (evaluated.ok) return imagesSupportedForLiveModel(evaluated.candidate.live)
  }
  return true
}

export type ImagesSupportedSubject = string | { live: Pick<OpenaiLiveModel, 'inputModalities'> } | undefined

export function imagesSupportedForModel(subject: ImagesSupportedSubject): boolean {
  if (typeof subject === 'string') return imagesSupportedForModelId(subject)
  return imagesSupportedForLiveModel(subject?.live)
}
