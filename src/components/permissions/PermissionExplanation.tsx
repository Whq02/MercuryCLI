import * as React from 'react'
import { useRef, useState } from 'react'
import { useLoad, useTimer } from '../../hooks/effects.js'
import { Box, Text } from '../../ink.js'
import { ShimmerChar } from '../Spinner/ShimmerChar.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { Message } from '../../types/message.js'
import {
  generatePermissionExplanation,
  isPermissionExplainerEnabled,
  type PermissionExplanation,
  type RiskLevel,
} from '../../services/permissions/permissionExplainer.js'
import { passedOverAs } from '../../utils/passedOver.js'
import { startInterval, stopInterval } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'

const RISK_LABEL: Record<RiskLevel, string> = {
  LOW: 'Low risk',
  MEDIUM: 'Med risk',
  HIGH: 'High risk',
}
const RISK_COLOR: Record<RiskLevel, string> = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'error',
}

export function usePermissionExplainerUI(arg0: {
  toolName: string
  toolInput: unknown
  toolDescription?: string
  messages?: Message[]
}): {
  visible: boolean
  enabled: boolean
  promise: Promise<PermissionExplanation | null> | null
} {
  return notBuilt('src/components/permissions/PermissionExplanation.tsx:28')
}

function ShimmerLine({ message }: { message: string }): React.ReactNode {
  const [sweep, setSweep] = useState(0)
  useTimer(() => {
    const cycle = message.length + 10
    const timer = startInterval(() => setSweep(current => (current + 1) % cycle), 60)
    return () => stopInterval(timer)
  }, [message])
  return (
    <Text>
      {message.split('').map((character, index) => (
        <ShimmerChar
          key={index}
          char={character}
          index={index}
          glimmerIndex={sweep}
          messageColor="permission"
          shimmerColor="permissionShimmer"
        />
      ))}
    </Text>
  )
}

export function PermissionExplainerContent(arg0: {
  visible: boolean
  promise: Promise<PermissionExplanation | null> | null
  fallback?: React.ReactNode
}): React.ReactNode {
  return notBuilt('src/components/permissions/PermissionExplanation.tsx:92')
}
