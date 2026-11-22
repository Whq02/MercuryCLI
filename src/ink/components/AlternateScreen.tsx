import React, { createContext, type PropsWithChildren, useContext, useInsertionEffect, useRef } from 'react';
import { InkInstanceContext } from './InkInstanceContext.js';
import { consumeLauncherAltHold } from '../launcherAltHold.js';
import { DISABLE_ALTERNATE_SCROLL, DISABLE_MOUSE_TRACKING, ENABLE_ALTERNATE_SCROLL, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../termio/dec.js';
import { noteModeAcquired, noteModeReleased } from '../root/terminalModeLedger.js';
import { TerminalWriteContext } from '../terminalWrite.js';
import { RESET_SCROLL_REGION } from '../termio/csi.js';
import Box from './Box.js';
import { TerminalSizeContext } from './TerminalSizeContext.js';
import { notBuilt, type Unbuilt } from '../../pi/holes.js'
type Props = Unbuilt;

const altScreenDepths = new WeakMap<object, { n: number }>()
const NO_INSTANCE_KEY = {}
const AltScreenDepthContext = createContext(0)

export function AlternateScreen(arg0: Props): React.ReactNode {
  return notBuilt('src/ink/components/AlternateScreen.tsx:18')
}
