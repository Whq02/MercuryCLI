import { createElement, type ReactNode } from 'react'
import { color } from './components/design-system/color.js'
import { ThemeProvider } from './components/design-system/ThemeProvider.js'
import baseRender, {
  createRoot as createBaseRoot,
  type Instance,
  type RenderOptions,
  type Root,
} from './ink/root.js'

export function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  return baseRender(createElement(ThemeProvider, null, node), options)
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  const root = await createBaseRoot(options)
  return {
    ...root,
    render: (node: ReactNode) =>
      root.render(createElement(ThemeProvider, null, node)),
  }
}

export type { Instance, RenderOptions, Root }
export { flushPendingSyncWork } from './ink/reconciler.js'

export { color } from './components/design-system/color.js'
export {
  ThemeProvider,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from './components/design-system/ThemeProvider.js'
export { default as Box } from './components/design-system/ThemedBox.js'
export type { Props as BoxProps } from './components/design-system/ThemedBox.js'
export { default as Text } from './components/design-system/ThemedText.js'
export type { Props as TextProps } from './components/design-system/ThemedText.js'
export { Ansi } from './ink/Ansi.js'
export { default as BaseBox } from './ink/components/Box.js'
export type { Props as BaseBoxProps } from './ink/components/Box.js'
export { default as BaseText } from './ink/components/Text.js'
export type { Props as BaseTextProps } from './ink/components/Text.js'
export { default as Button } from './ink/components/Button.js'
export type { ButtonState, Props as ButtonProps } from './ink/components/Button.js'
export { default as Link } from './ink/components/Link.js'
export type { Props as LinkProps } from './ink/components/Link.js'
export { MotionParkContext } from './ink/components/MotionParkContext.js'
export { default as Newline } from './ink/components/Newline.js'
export type { Props as NewlineProps } from './ink/components/Newline.js'
export { NoSelect } from './ink/components/NoSelect.js'
export { RawAnsi } from './ink/components/RawAnsi.js'
export { default as Spacer } from './ink/components/Spacer.js'
export type { Props as AppProps } from './ink/components/AppContext.js'
export type { Props as StdinProps } from './ink/components/StdinContext.js'
export { ClickEvent } from './ink/events/click-event.js'
export { EventEmitter } from './ink/events/emitter.js'
export { Event } from './ink/events/event.js'
export { InputEvent } from './ink/events/input-event.js'
export type { Key } from './ink/events/input-event.js'
export { TerminalFocusEvent } from './ink/events/terminal-focus-event.js'
export type { TerminalFocusEventType } from './ink/events/terminal-focus-event.js'
export { FocusManager } from './ink/focus.js'
export { paletteCollapsed, truecolorActive } from './ink/colorize.js'
export { default as measureElement, elementScreenLeft, elementScreenTop } from './ink/measure-element.js'
export { supportsTabStatus } from './ink/termio/osc.js'
export { default as wrapText } from './ink/wrap-text.js'
export type { DOMElement } from './ink/dom.js'
export type { FlickerReason } from './ink/frame.js'
export { useAnimationFrame } from './ink/hooks/use-animation-frame.js'
export { useAnimationValue } from './ink/hooks/use-animation-value.js'
export { default as useApp } from './ink/hooks/use-app.js'
export { default as useInput } from './ink/hooks/use-input.js'
export { useAnimationTimer, useInterval } from './ink/hooks/use-interval.js'
export { useSelection } from './ink/hooks/use-selection.js'
export { default as useStdin } from './ink/hooks/use-stdin.js'
export { useTerminalFocus } from './ink/hooks/use-terminal-focus.js'
export { useTerminalTitle } from './ink/hooks/use-terminal-title.js'
export { useTerminalViewport } from './ink/hooks/use-terminal-viewport.js'
