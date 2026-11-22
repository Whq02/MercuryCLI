import React, { memo, useRef, useState } from 'react'
import { useMeasure } from '../hooks/effects.js'
import { Ansi, Box, NoSelect, Text, measureElement } from '../ink.js'
import type { DOMElement } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { linkifyCodeUrls } from '../utils/hyperlink.js'
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js'
import { Suspense } from 'react'
import { unbuilt, type Unbuilt } from '../pi/holes.js'

export const HighlightedCode: Unbuilt = unbuilt('src/components/HighlightedCode.tsx:12')

export default HighlightedCode
