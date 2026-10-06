import { mediaRefusalOf } from '../../services/api/mediaRefusal.js'
import { declaredRouteOf, providerDisplayName } from '../../services/providers/routeLaw.js'
import type { Message, UserMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'

export const IMAGE_REFUSAL_RETRY_CLASS = 'image'

export function imageRefusalRetryLine(model: string, detail: string | undefined): string {
  const route = declaredRouteOf(model)
  const where = route === null ? `The model ${model} on its route` : `The model ${model} on the ${providerDisplayName(route)} route`
  return (
    `${where} refused an image in the last request${detail !== undefined && detail !== '' ? ` (${detail})` : ''}: ` +
    'the image now goes to it as [image]. Carry on — describe what you need from it in words.'
  )
}

export function refusalRetryRowOf(
  lastAssistant: Message | undefined,
  retried: ReadonlySet<string>,
  model: string,
): { refusalClass: string; row: UserMessage } | null {
  const stamp = mediaRefusalOf(lastAssistant)
  if (stamp === null || !stamp.blockTypes.includes(IMAGE_REFUSAL_RETRY_CLASS)) return null
  if (retried.has(IMAGE_REFUSAL_RETRY_CLASS)) return null
  return {
    refusalClass: IMAGE_REFUSAL_RETRY_CLASS,
    row: createUserMessage({ content: imageRefusalRetryLine(model, stamp.detail), isMeta: true }),
  }
}
