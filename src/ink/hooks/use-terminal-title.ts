// Declarative terminal/tab title. Layered sanitisation is mandatory: strip
// well-formed escape sequences, THEN every remaining control byte (C0, DEL,
// C1) — a bare BEL or ESC inside the OSC 0 payload would terminate the title
// early and leak the remainder as live input. Both platform branches are
// gated on the raw-write channel; without one the hook is inert everywhere.

import { useContext, useEffect } from 'react'
import stripAnsi from 'strip-ansi'
import { OSC, osc } from '../termio/osc.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

const CONTROL_BYTES_RE = /[\x00-\x1f\x7f-\x9f]/g

function sanitizeTitle(title: string): string {
  return stripAnsi(title).replace(CONTROL_BYTES_RE, '')
}

export function useTerminalTitle(title: string | null): void {
  const write = useContext(TerminalWriteContext)
  useEffect(() => {
    if (title === null || !write) return
    const clean = sanitizeTitle(title)
    if (process.platform === 'win32') {
      // The classic Windows console does not honour the OSC form.
      process.title = clean
      return
    }
    write(osc(OSC.SET_TITLE_AND_ICON, clean))
  }, [title, write])
}
