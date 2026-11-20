
import { useCallback, useContext, useRef } from 'react'
import { useLayoutClaim, useLayoutPublish } from '../../hooks/effects.js'
import CursorDeclarationContext from '../components/CursorDeclarationContext.js'
import type { DOMElement } from '../dom.js'

export function useDeclaredCursor({
  line,
  column,
  active,
}: {
  line: number
  column: number
  active: boolean
}): (el: DOMElement | null) => void {
  const setDeclaration = useContext(CursorDeclarationContext)
  const nodeRef = useRef<DOMElement | null>(null)

  const ref = useCallback((el: DOMElement | null) => {
    nodeRef.current = el
  }, [])

  useLayoutPublish(() => {
    const node = nodeRef.current
    if (active && node) {
      setDeclaration({ relativeX: column, relativeY: line, node })
    } else {
      setDeclaration(null, node)
    }
  })

  useLayoutClaim(() => {
    return () => {
      setDeclaration(null, nodeRef.current)
    }
  }, [])

  return ref
}
