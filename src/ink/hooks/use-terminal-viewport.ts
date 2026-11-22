import { useCallback, useContext, useRef } from 'react'
import { useMeasure } from '../../hooks/effects.js'
import { LiveTerminalSizeContext, TerminalSizeContext } from '../components/TerminalSizeContext.js'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import type { DOMElement } from '../dom.js'
import { notBuilt } from '../../pi/holes.js'

type ViewportEntry = { isVisible: boolean }

const VISIBLE: ViewportEntry = { isVisible: true }
const HIDDEN: ViewportEntry = { isVisible: false }

export function useTerminalViewport(): [
  ref: (el: DOMElement | null) => void,
  entry: ViewportEntry,
] {
  return notBuilt('src/ink/hooks/use-terminal-viewport.ts:13')
}
