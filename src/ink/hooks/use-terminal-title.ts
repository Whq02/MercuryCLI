
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
      process.title = clean
      return
    }
    write(osc(OSC.SET_TITLE_AND_ICON, clean))
  }, [title, write])
}
