
import { useContext } from 'react'
import { usePublish } from '../../hooks/effects.js'
import stripAnsi from 'strip-ansi'
import { partiallySanitizeUnicode } from '../../utils/sanitization.js'
import { noteModeAcquired } from '../root/terminalModeLedger.js'
import { OSC, osc } from '../termio/osc.js'
import { TerminalWriteContext } from '../terminalWrite.js'
import { terminalTitleTransport } from '../../utils/platform/terminal.js'

const CONTROL_BYTES_RE = /[\x00-\x1f\x7f-\x9f]/g

function sanitizeTitle(title: string): string {
  return partiallySanitizeUnicode(stripAnsi(title)).replace(CONTROL_BYTES_RE, '')
}

export function useTerminalTitle(title: string | null): void {
  const write = useContext(TerminalWriteContext)
  usePublish(() => {
    if (title === null || !write) return
    const clean = sanitizeTitle(title)
    if (terminalTitleTransport() === 'process-title') {
      process.title = clean
      noteModeAcquired('terminal-title', 'terminal-title')
      return
    }
    write(osc(OSC.SET_TITLE_AND_ICON, clean))
    noteModeAcquired('terminal-title', 'terminal-title')
  }, [title, write])
}
