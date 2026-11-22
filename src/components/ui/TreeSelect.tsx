import React, { useRef, useState } from 'react'
import { Box } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Select } from '../CustomSelect/select.js'
import { GLYPH } from '../../utils/glyphs.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const EXPANDED_MARKER = `${GLYPH.chevronDown} `
const COLLAPSED_MARKER = `${GLYPH.chevronRight} `
const CHILD_MARKER = '  ▸ '

type TreeSelectProps<T> = Unbuilt

export function TreeSelect<T>(arg0: TreeSelectProps<T>): React.ReactNode {
  return notBuilt('src/components/ui/TreeSelect.tsx:46')
}
