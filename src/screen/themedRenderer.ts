import { createElement, type ReactNode } from 'react'
import { ThemeProvider } from './theme/ThemeProvider.js'
import renderBare, { createRoot as createBareRoot, type Instance, type RenderOptions, type Root } from './renderer/root.js'

function withTheme(node: ReactNode): ReactNode {
  return createElement(ThemeProvider, null, node)
}

export function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  return renderBare(withTheme(node), options)
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  const root = await createBareRoot(options)
  return {
    ...root,
    render: (node: ReactNode) => root.render(withTheme(node)),
  }
}

export type { Instance, RenderOptions, Root }
export { flushPendingSyncWork } from './renderer/reconciler.js'

export { color } from './theme/color.js'
export {
  ThemeProvider,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from './theme/ThemeProvider.js'
export { default as Box } from './theme/ThemedBox.js'
export type { Props as BoxProps } from './theme/ThemedBox.js'
export { default as Text } from './theme/ThemedText.js'
export type { Props as TextProps } from './theme/ThemedText.js'
export { Ansi } from './renderer/Ansi.js'
export { default as BaseBox } from './renderer/elements/Box.js'
export type { Props as BaseBoxProps } from './renderer/elements/Box.js'
export { default as BaseText } from './renderer/elements/Text.js'
export type { Props as BaseTextProps } from './renderer/elements/Text.js'
export { default as Button } from './renderer/elements/Button.js'
export type { ButtonState, Props as ButtonProps } from './renderer/elements/Button.js'
export { default as Link } from './renderer/elements/Link.js'
export type { Props as LinkProps } from './renderer/elements/Link.js'
export { MotionParkContext } from './renderer/elements/MotionParkContext.js'
export { default as Newline } from './renderer/elements/Newline.js'
export type { Props as NewlineProps } from './renderer/elements/Newline.js'
export { NoSelect } from './renderer/elements/NoSelect.js'
export { RawAnsi } from './renderer/elements/RawAnsi.js'
export { default as Spacer } from './renderer/elements/Spacer.js'
export type { Props as AppProps } from './renderer/elements/AppContext.js'
export type { Props as StdinProps } from './renderer/elements/StdinContext.js'
export { ClickEvent } from './renderer/events/click-event.js'
export { EventEmitter } from './renderer/events/emitter.js'
export { Event } from './renderer/events/event.js'
export { InputEvent } from './renderer/events/input-event.js'
export type { Key } from './renderer/events/input-event.js'
export { TerminalFocusEvent } from './renderer/events/terminal-focus-event.js'
export type { TerminalFocusEventType } from './renderer/events/terminal-focus-event.js'
export { FocusManager } from './renderer/focus.js'
export { paletteCollapsed, truecolorActive } from './renderer/colorize.js'
export { default as measureElement, elementScreenLeft, elementScreenTop } from './renderer/measure-element.js'
export { supportsTabStatus } from './renderer/termio/osc.js'
export { default as wrapText } from './renderer/wrap-text.js'
export type { DOMElement } from './renderer/dom.js'
export type { FlickerReason } from './renderer/frame.js'
export { useAnimationFrame } from './renderer/bindings/use-animation-frame.js'
export { useAnimationValue } from './renderer/bindings/use-animation-value.js'
export { default as useApp } from './renderer/bindings/use-app.js'
export { default as useInput } from './renderer/bindings/use-input.js'
export { useAnimationTimer, useInterval } from './renderer/bindings/use-interval.js'
export { useSelection } from './renderer/bindings/use-selection.js'
export { default as useStdin } from './renderer/bindings/use-stdin.js'
export { useTerminalFocus } from './renderer/bindings/use-terminal-focus.js'
export { useTerminalTitle } from './renderer/bindings/use-terminal-title.js'
export { useTerminalViewport } from './renderer/bindings/use-terminal-viewport.js'
