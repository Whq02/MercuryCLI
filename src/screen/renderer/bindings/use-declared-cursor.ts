import { useCallback, useContext, useRef } from 'react'
import { useLayoutClaim, useLayoutPublish } from '../../effects/effects.js'
import CursorDeclarationContext from '../elements/CursorDeclarationContext.js'
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
  const setCursor = useContext(CursorDeclarationContext)
  const nodeRef = useRef<DOMElement | null>(null)
  const ownedRef = useRef<DOMElement | null>(null)

  const ref = useCallback((el: DOMElement | null) => {
    nodeRef.current = el
  }, [])

  useLayoutPublish(() => {
    const node = nodeRef.current
    if (active && node) {
      ownedRef.current = node
      setCursor({ node, relativeX: column, relativeY: line })
    } else {
      const owner = node ?? ownedRef.current
      if (owner) {
        setCursor(null, owner)
        ownedRef.current = null
      }
    }
  })

  useLayoutClaim(() => {
    return () => {
      const owner = nodeRef.current ?? ownedRef.current
      if (owner) {
        setCursor(null, owner)
        ownedRef.current = null
      }
    }
  }, [setCursor])

  return ref
}
