
import { createContext } from 'react'
import type { DOMElement } from '../dom.js'

export type CursorDeclaration = {
  readonly relativeX: number
  readonly relativeY: number
  readonly node: DOMElement
}

export type CursorDeclarationSetter = (
  declaration: CursorDeclaration | null,
  clearIfNode?: DOMElement | null,
) => void

const CursorDeclarationContext = createContext<CursorDeclarationSetter>(() => {})

export default CursorDeclarationContext
