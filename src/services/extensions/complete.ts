import { randomUUID } from 'node:crypto'
import type { AssistantMessage } from '../../types/message.js'
import { notBuilt } from '../../pi/holes.js'
type CompletionRequest = { model: string; system: string; prompt: string; signal: AbortSignal }
type CompletionReply = { model: string; costUsd: number | null; inputTokens: number; outputTokens: number } & ({ ok: true; text: string } | { ok: false; error: string })

export const completeExternal = async (request: CompletionRequest): Promise<CompletionReply> => notBuilt('src/services/extensions/complete.ts:6')
