import { useClaim } from './effects.js'
import type { Message } from '../types/message.js'
import { createSeatReceiptMessage } from '../services/messages.js'
import { subscribeSeatReceipts } from '../utils/model/seatReceipts.js'

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
