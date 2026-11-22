import figures from 'figures'
import { GLYPH } from '../utils/glyphs.js'
import React, { useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useTimer } from '../hooks/effects.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { isTaskToolsEnabled } from '../utils/tasks.js'

type TaskRowV2 = { id: string; status: 'pending' | 'in_progress' | 'completed'; subject: string; blockedBy?: readonly string[]; owner?: string }
import { truncateToWidth } from '../utils/truncate.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt } from '../pi/holes.js'

const RECENT_COMPLETION_MS = 30_000

function compareIds(a: string, b: string): number {
  const an = Number(a)
  const bn = Number(b)
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  return a < b ? -1 : a > b ? 1 : 0
}

export function TaskListV2(arg0: {
  tasks: readonly TaskRowV2[]
  isStandalone?: boolean
}): React.ReactNode {
  return notBuilt('src/components/TaskListV2.tsx:24')
}

export default TaskListV2
