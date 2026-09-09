import { useSyncExternalStore } from 'react'
import {
  idleMotionLevel,
  settledMotionLevel,
  restMotionPaused,
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

export function useSettledMotion(part: IdleMotionPart): IdleMotionLevel {
  primeMotionSetting()
  return useSyncExternalStore(subscribeIdleMotion, () => settledMotionLevel(part), () => settledMotionLevel(part))
}

export function useRestMotionPause(): boolean {
  primeMotionSetting()
  return useSyncExternalStore(subscribeIdleMotion, restMotionPaused, restMotionPaused)
}
