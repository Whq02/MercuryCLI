import * as React from 'react'
import { registerElevatedSurface } from '../../ink/recessLayer.js'
import type { DOMElement } from '../../ink.js'

export function useElevatedSurface(): (el: DOMElement | null) => void {
  const unregRef = React.useRef<(() => void) | null>(null)
  return React.useCallback((el: DOMElement | null) => {
    unregRef.current?.()
    unregRef.current = el ? registerElevatedSurface(el) : null
  }, [])
}
