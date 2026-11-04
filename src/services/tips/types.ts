import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { ThemeName } from '../../utils/theme.js'

export type TipTensorFoldContext = {
  installed?: boolean
  serving?: boolean
  pairedHost?: boolean
  helperEnabled?: boolean
}

export type TipContext = {
  theme: ThemeName
  readFileState?: FileStateCache
  bashTools?: Set<string>
  model?: string
  localServersCount?: number
  llmHostConfigured?: boolean
  tensorfold?: TipTensorFoldContext
}

export type Tip = {
  id: string
  content(ctx: { theme: ThemeName }): Promise<string>
  cooldownSessions: number
  isRelevant(context?: TipContext): Promise<boolean>
}
