// useSeatReceipts — mounts the screen-receipt stream into the transcript:
// each minted receipt (a refused chat birth, an applied daemon change) lands
// as ONE seat_receipt system row. The dedicated subtype is load-bearing:
// info-level informational rows are quiet-by-design in the default
// transcript view (the verbose gate), and a receipt must never be quiet —
// seat_receipt renders above that gate. The queue lives in
// utils/model/seatReceipts.ts; this hook is just the setMessages bridge (the
// shape the old REPL scheduler hook used, kept).
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
