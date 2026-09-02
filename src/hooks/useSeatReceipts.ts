// useSeatReceipts — mounts the reslot-receipt stream into the
// transcript: each applied (or honestly timed-out) operator reslot lands as
// ONE seat_receipt system row. The dedicated subtype is load-bearing:
// info-level informational rows are quiet-by-design in the default
// transcript view (the verbose gate), and a receipt must never be quiet —
// seat_receipt renders above that gate. The
// registry/observers live in utils/model/seatReceipts.ts (armed only while a
// reslot is pending — zero standing cost); this hook is just the setMessages
// bridge (the shape the old REPL scheduler hook used, kept).
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
    // setMessages is the REPL's stable useCallback (the standing hook contract).
  }, [setMessages])
}
