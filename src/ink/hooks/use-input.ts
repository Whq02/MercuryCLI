import { useRef } from 'react'
import { useClaim, useLayoutClaim } from '../../hooks/effects.js'
import type { InputEvent, Key } from '../events/input-event.js'
import useStdin from './use-stdin.js'

type InputHandler = (input: string, key: Key, event: InputEvent) => void

type Options = {
  isActive?: boolean
}

export default function useInput(handler: InputHandler, options: Options = {}): void {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()
  const isActive = options.isActive !== false

  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  useLayoutClaim(() => {
    if (!isActive) return
    setRawMode(true)
    return () => {
      setRawMode(false)
    }
  }, [isActive, setRawMode])

  const listenerRef = useRef<((event: InputEvent) => void) | null>(null)
  if (listenerRef.current === null) {
    const exitOnCtrlC = internal_exitOnCtrlC
    listenerRef.current = (event: InputEvent) => {
      if (!isActiveRef.current) return
      const { input, key } = event
      if (input === 'c' && key.ctrl && exitOnCtrlC) return
      handlerRef.current(input, key, event)
    }
  }

  useClaim(() => {
    const listener = listenerRef.current!
    internal_eventEmitter.on('input', listener)
    return () => {
      internal_eventEmitter.removeListener('input', listener)
    }
  }, [internal_eventEmitter])
}
