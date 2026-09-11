import { useSyncExternalStore } from 'react'
import {
  idleMotionLevel,
  subscribeIdleMotion,
  type IdleMotionLevel,
  type IdleMotionPart,
} from '../utils/cockpit/motionGovernor.js'
import { primeMotionSetting } from '../utils/cockpit/motionSetting.js'

export function useIdleMotion(part: IdleMotionPart): IdleMotionLevel {
  primeMotionSetting()
  return useSyncExternalStore(
    subscribeIdleMotion,
    () => idleMotionLevel(part),
    () => idleMotionLevel(part),
  )
}
