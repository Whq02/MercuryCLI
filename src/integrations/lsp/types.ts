import type { z } from 'zod/v4'
import type { LspServerConfigSchema } from './lspServerConfigSchema.js'

type LspServerConfig = z.infer<ReturnType<typeof LspServerConfigSchema>>

export type ScopedLspServerConfig = LspServerConfig & {
  scope: 'dynamic'
  source: string
}

export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'
