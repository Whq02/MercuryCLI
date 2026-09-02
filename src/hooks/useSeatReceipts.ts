import { useEffect } from 'react'
import type { Message } from '../types/message.js'
import { createSeatReceiptMessage } from '../utils/messages.js'
import { subscribeSeatReceipts } from '../utils/model/seatReceipts.js'

export function useSeatReceipts({
  setMessages,
}: {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
}): void {
  useEffect(() => {
    return subscribeSeatReceipts(r => {
      setMessages(prev => [...prev, createSeatReceiptMessage(r.text, r.level)])
    })
  }, [setMessages])
}
