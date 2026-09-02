// The cursor declaration context: the value IS the setter.

import { createContext } from 'react'
import type { DOMElement } from '../dom.js'

export type CursorDeclaration = {
  /** Display column within the declared node. */
  readonly relativeX: number
  /** Line number within the declared node. */
  readonly relativeY: number
  /** The box element whose layout provides the absolute origin. */
  readonly node: DOMElement
}

export type CursorDeclarationSetter = (
  declaration: CursorDeclaration | null,
  clearIfNode?: DOMElement | null,
) => void

const CursorDeclarationContext = createContext<CursorDeclarationSetter>(() => {})

export default CursorDeclarationContext
