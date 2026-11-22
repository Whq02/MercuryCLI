import { useRef } from 'react'
import { usePublish } from '../effects.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { getModelDeprecationWarning } from '../../utils/model/deprecation.js'
import { notBuilt } from '../../pi/holes.js'

const NOTIFICATION_KEY = 'model-deprecation-warning'

export function useDeprecationWarningNotification(model: string): void {
  return notBuilt('src/hooks/notifs/useDeprecationWarningNotification.tsx:10')
}
