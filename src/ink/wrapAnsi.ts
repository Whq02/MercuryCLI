import bundledWrapAnsi from 'wrap-ansi'
import sliceAnsi from '../utils/sliceAnsi.js'
import { terminalTextCells } from './session/terminalTextCells.js'
import { stringWidth } from './stringWidth.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type WrapAnsiOptions = Unbuilt

type NativeWrapAnsi = (...args: Unbuilt[]) => Unbuilt

const nativeWrapAnsi: NativeWrapAnsi | undefined = (
  globalThis as { Bun?: { wrapAnsi?: NativeWrapAnsi } }
).Bun?.wrapAnsi

const VARIATION_SELECTOR_RE = /[\uFE00-\uFE0F]/

export function wrapAnsi(
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
): string {
  return notBuilt('src/ink/wrapAnsi.ts:25')
}
