// The stdin context: six value keys, all contract data (the three
// `internal_` spellings included).

import { createContext } from 'react'
import { EventEmitter } from '../events/emitter.js'
import type { TerminalQuerier } from '../session/querier.js'

export type Props = {
  readonly stdin: NodeJS.ReadStream
  /** The raw-mode setter components must use instead of the stream's own,
   *  so the interrupt character can be handled. */
  readonly setRawMode: (value: boolean) => void
  readonly isRawModeSupported: boolean
  readonly internal_exitOnCtrlC: boolean
  readonly internal_eventEmitter: EventEmitter
  /** Null only in the never-reached default value. */
  readonly internal_querier: TerminalQuerier | null
}

const StdinContext = createContext<Props>({
  stdin: process.stdin,
  setRawMode() {},
  isRawModeSupported: false,
  internal_exitOnCtrlC: true,
  internal_eventEmitter: new EventEmitter(),
  internal_querier: null,
})

StdinContext.displayName = 'InternalStdinContext'

export default StdinContext
