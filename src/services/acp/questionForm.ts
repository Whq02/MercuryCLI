import type { CreateElicitationRequest, ElicitationPropertySchema } from '@agentclientprotocol/sdk'
import type { PermissionAnswer } from '../../runner/wire/methods.js'
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import type { ToolAsk } from './childSession.js'
import { notBuilt } from '../../pi/holes.js'

export function questionFormOf(ask: ToolAsk, sessionId: string): {
  request: CreateElicitationRequest
  answer: (result: unknown) => PermissionAnswer
} | null {
  return notBuilt('src/services/acp/questionForm.ts:6')
}
