// The keystroke-subscription hook. Raw mode is managed in the LAYOUT phase
// (a deferred effect leaves the terminal cooked for a tick — echoed keys
// and a visible cursor); the listener registers ONCE and reads the latest
// handler and active flag through refs, because re-registering on
// activation changes would move it behind later listeners and break the
// stop-immediate-propagation ordering that decides who owns a key.

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { InputEvent, Key } from '../events/input-event.js'
import useStdin from './use-stdin.js'

export type InputHandler = (input: string, key: Key, event: InputEvent) => void

type Options = {
  /** Tested against the literal false: absent or undefined means active. */
  isActive?: boolean
}

export default function useInput(handler: InputHandler, options: Options = {}): void {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()
  const isActive = options.isActive !== false

  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const activeRef = useRef(isActive)
  activeRef.current = isActive

  useLayoutEffect(() => {
    if (!isActive) return
    setRawMode(true)
    return () => {
      setRawMode(false)
    }
  }, [isActive, setRawMode])

  const wrapperRef = useRef<((event: InputEvent) => void) | null>(null)
  if (wrapperRef.current === null) {
    wrapperRef.current = (event: InputEvent) => {
      if (!activeRef.current) return
      const { input, key } = event
      // The exit path owns ctrl+c when configured to exit on it.
      if (input === 'c' && key.ctrl && internal_exitOnCtrlC) return
      handlerRef.current(input, key, event)
    }
  }

  useEffect(() => {
    const wrapper = wrapperRef.current!
    internal_eventEmitter.on('input', wrapper)
    return () => {
      internal_eventEmitter.removeListener('input', wrapper)
    }
  }, [internal_eventEmitter])
}
