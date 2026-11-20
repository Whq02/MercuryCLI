
import { useRef } from 'react'
import { useLayoutClaim, useSubscription } from '../../hooks/effects.js'
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
  const activeRef = useRef(isActive)
  activeRef.current = isActive

  useLayoutClaim(() => {
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
      if (input === 'c' && key.ctrl && internal_exitOnCtrlC) return
      handlerRef.current(input, key, event)
    }
  }

  useSubscription(() => {
    const wrapper = wrapperRef.current!
    internal_eventEmitter.on('input', wrapper)
    return () => {
      internal_eventEmitter.removeListener('input', wrapper)
    }
  }, [internal_eventEmitter])
}
