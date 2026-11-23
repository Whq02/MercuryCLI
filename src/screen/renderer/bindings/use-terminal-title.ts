import { useContext } from 'react'
import stripAnsi from 'strip-ansi'
import { usePublish } from '../../effects/effects.js'
import { terminalTitleTransport } from '../../../platform/host-os/terminal.js'
import { partiallySanitizeUnicode } from '../../../platform/text/unicodeSanitization.js'
import { noteModeAcquired } from '../root/terminalModeLedger.js'
import { TerminalWriteContext } from '../terminalWrite.js'
import { osc, OSC } from '../termio/osc.js'

export function useTerminalTitle(title: string | null): void {
  const write = useContext(TerminalWriteContext)
  usePublish(() => {
    if (title === null || write === null) return
    const safeTitle = partiallySanitizeUnicode(stripAnsi(title)).replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    if (terminalTitleTransport() === 'process-title') {
      process.title = safeTitle
    } else {
      write(osc(OSC.SET_TITLE_AND_ICON, safeTitle))
    }
    noteModeAcquired('terminal-title', 'terminal-title')
  }, [title, write])
}
