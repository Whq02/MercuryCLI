
import { createContext } from 'react'
import { EventEmitter } from '../events/emitter.js'
import type { TerminalQuerier } from '../session/querier.js'

export type Props = {
  readonly stdin: NodeJS.ReadStream
  readonly setRawMode: (value: boolean) => void
  readonly isRawModeSupported: boolean
  readonly internal_exitOnCtrlC: boolean
  readonly internal_eventEmitter: EventEmitter
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
