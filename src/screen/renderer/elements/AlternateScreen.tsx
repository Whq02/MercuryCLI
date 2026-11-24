import React, { createContext, type PropsWithChildren, useContext, useInsertionEffect, useRef } from 'react';
import { ScreenInstanceContext } from './InkInstanceContext.js';
import { consumeLauncherAltHold } from '../launcherAltHold.js';
import { DISABLE_ALTERNATE_SCROLL, DISABLE_MOUSE_TRACKING, ENABLE_ALTERNATE_SCROLL, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../termio/dec.js';
import { noteModeAcquired, noteModeReleased } from '../root/terminalModeLedger.js';
import { TerminalWriteContext } from '../terminalWrite.js';
import { RESET_SCROLL_REGION } from '../termio/csi.js';
import Box from './Box.js';
import { TerminalSizeContext } from './TerminalSizeContext.js';
type Props = PropsWithChildren<{
  readonly mouseTracking?: boolean
}>

const altScreenDepths = new WeakMap<object, { n: number }>()
const NO_INSTANCE_KEY = {}
const AltScreenDepthContext = createContext(0)

export function AlternateScreen({ children, mouseTracking = true }: Props): React.ReactNode {
  const write = useContext(TerminalWriteContext)
  const instance = useContext(ScreenInstanceContext)
  const size = useContext(TerminalSizeContext)
  const depth = useContext(AltScreenDepthContext)
  const mouseTrackingRef = useRef(mouseTracking)
  mouseTrackingRef.current = mouseTracking

  useInsertionEffect(() => {
    if (!write) return
    const key = instance ?? NO_INSTANCE_KEY
    let entry = altScreenDepths.get(key)
    if (!entry) {
      entry = { n: 0 }
      altScreenDepths.set(key, entry)
    }
    const wantMouse = mouseTrackingRef.current && (instance?.isMouseTrackingPreferred?.() ?? true)
    const wasZero = entry.n === 0
    entry.n += 1
    if (wasZero) {
      const held = consumeLauncherAltHold()
      const arm = (wantMouse ? ENABLE_MOUSE_TRACKING : '') + ENABLE_ALTERNATE_SCROLL
      if (held) {
        write(RESET_SCROLL_REGION + '\x1b[0m' + arm)
      } else {
        const seq = ENTER_ALT_SCREEN + RESET_SCROLL_REGION + '\x1b[2J\x1b[H' + arm
        if (instance?.armAltScreenEntry) {
          instance.armAltScreenEntry(seq)
        } else {
          write(seq)
        }
      }
      noteModeAcquired('alt-screen-session', 'alt-screen')
      noteModeAcquired('alt-screen-session', 'alternate-scroll')
      if (wantMouse) {
        noteModeAcquired('alt-screen-session', 'mouse-tracking')
      }
      instance?.setAltScreenActive(true, wantMouse)
      if (held) {
        instance?.armAltScreenTakeover()
      }
    } else {
      if (!instance?.isAltEntryPending?.()) {
        write(RESET_SCROLL_REGION)
      }
      instance?.repaintAfterNestedAltScreenClose?.()
    }

    return () => {
      entry.n = Math.max(0, entry.n - 1)
      if (entry.n === 0) {
        instance?.setAltScreenActive(false)
        instance?.clearTextSelection()
        write(DISABLE_ALTERNATE_SCROLL + DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN)
        noteModeReleased('alt-screen-session', 'alt-screen')
        noteModeReleased('alt-screen-session', 'alternate-scroll')
        noteModeReleased('alt-screen-session', 'mouse-tracking')
      } else {
        instance?.clearTextSelection()
        instance?.repaintAfterNestedAltScreenClose?.()
      }
    }
  }, [write, instance])

  const rows = size?.rows ?? 24
  const nested = depth > 0
  return (
    <Box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      {...(nested ? { maxHeight: rows } : { height: rows })}
    >
      <AltScreenDepthContext.Provider value={depth + 1}>
        <TerminalSizeContext.Provider value={size}>
          {children}
        </TerminalSizeContext.Provider>
      </AltScreenDepthContext.Provider>
    </Box>
  )
}
