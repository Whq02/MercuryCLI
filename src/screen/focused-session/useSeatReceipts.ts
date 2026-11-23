import { useClaim } from '../effects/effects.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { createSeatReceiptMessage } from '../../engine/messages/messages.js'
import { subscribeSeatReceipts } from '../../models/facts/seatReceipts.js'

export function useSeatReceipts({
  setMessages,
}: {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
}): void {
  useClaim(() => {
    return subscribeSeatReceipts(r => {
      setMessages(prev => [...prev, createSeatReceiptMessage(r.text, r.level, r.copyText)])
    })
  }, [setMessages])
}
