import type { AssistantMessage, Message } from '../../types/message.js'

export type RefusedMediaBlockType = 'image' | 'document'

export type MediaRefusal = {
  blockTypes: RefusedMediaBlockType[]
  detail?: string
}

const DETAIL_MAX_CHARS = 240

const IMAGE_REFUSAL_NEEDLE = /\b(images?|image_url|input_image|vision|multimodal|modalit(?:y|ies))\b/i

export function providerRefusedImage(faultMessage: string): boolean {
  return IMAGE_REFUSAL_NEEDLE.test(faultMessage)
}

function bounded(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined
  return flat.length > DETAIL_MAX_CHARS ? `${flat.slice(0, DETAIL_MAX_CHARS - 1)}…` : flat
}

export function classifyImageRefusalFault(
  fault: { status?: number; message: string },
  requestCarriedImage: boolean,
): MediaRefusal | null {
  if (!requestCarriedImage || fault.status !== 400 || !providerRefusedImage(fault.message)) return null
  const detail = bounded(fault.message)
  return { blockTypes: ['image'], ...(detail !== undefined ? { detail } : {}) }
}

export function mediaRefusalOf(message: Message | undefined): MediaRefusal | null {
  if (message === undefined || message.type !== 'assistant') return null
  const stamped = (message as AssistantMessage).mediaRefusal
  if (stamped === undefined || !Array.isArray(stamped.blockTypes) || stamped.blockTypes.length === 0) return null
  return stamped
}
