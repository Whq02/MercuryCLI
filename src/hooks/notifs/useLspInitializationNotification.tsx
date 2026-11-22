import { useCallback, useRef, useState } from 'react'
import { useTimer } from '../effects.js'
import { getIsRemoteMode, getIsScrollDraining } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import { GLYPH } from '../../utils/glyphs.js'
import {
  getInitializationStatus,
  getLspServerManager,
} from '../../services/lsp/manager.js'
import { logForDebugging } from '../../utils/debug.js'
import { pollUntil } from '../../utils/deadline.js'
import { notBuilt } from '../../pi/holes.js'

const POLL_INTERVAL_MS = 5000
const NOTIFICATION_TIMEOUT_MS = 8000

export function useLspInitializationNotification(): void {
  return notBuilt('src/hooks/notifs/useLspInitializationNotification.tsx:18')
}
