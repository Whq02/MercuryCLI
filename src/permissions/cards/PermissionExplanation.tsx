import * as React from 'react'
import { useRef, useState } from 'react'
import { useLoad, useTimer } from '../../screen/effects/effects.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import { ShimmerChar } from '../../screen/spinner/ShimmerChar.js'
import { useKeybinding } from '../../screen/keys/useKeybinding.js'
import type { Message } from '../../engine/message-shapes/message.js'
import {
  generatePermissionExplanation,
  isPermissionExplainerEnabled,
  type PermissionExplanation,
  type RiskLevel,
} from '../explainer/permissionExplainer.js'
import { passedOverAs } from '../../platform/errors/passedOver.js'
import { startInterval, stopInterval } from '../../platform/async/timers.js'

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

export function usePermissionExplainerUI({
  toolName,
  toolInput,
  toolDescription,
  messages,
}: {
  toolName: string
  toolInput: unknown
  toolDescription?: string
  messages?: Message[]
}): {
  visible: boolean
  enabled: boolean
  promise: Promise<PermissionExplanation | null> | null
} {
  const enabled = isPermissionExplainerEnabled()
  const [visible, setVisible] = useState(false)
  const [promise, setPromise] = useState<Promise<PermissionExplanation | null> | null>(null)
  const promiseRef = useRef<Promise<PermissionExplanation | null> | null>(null)
  const signalRef = useRef<AbortSignal | null>(null)

  useLoad(signal => {
    signalRef.current = signal
  }, [])

  useKeybinding(
    'confirm:toggleExplanation',
    () => {
      if (!promiseRef.current && signalRef.current) {
        const started = generatePermissionExplanation({
          toolName,
          toolInput,
          toolDescription,
          messages,
          signal: signalRef.current,
        }).catch(passedOverAs(null))
        promiseRef.current = started
        setPromise(started)
      }
      setVisible(prev => !prev)
    },
    { context: 'Confirmation', isActive: enabled },
  )

  return { visible, enabled, promise }
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

export function PermissionExplainerContent({
  visible,
  promise,
  fallback,
}: {
  visible: boolean
  promise: Promise<PermissionExplanation | null> | null
  fallback?: React.ReactNode
}): React.ReactNode {
  const [resolved, setResolved] = useState<PermissionExplanation | null | 'pending'>('pending')

  useLoad(signal => {
    if (!promise) return
    setResolved('pending')
    void promise.then(value => {
      if (signal.aborted) return
      setResolved(value)
    })
  }, [promise])

  if (!visible || !promise) return null

  if (resolved === 'pending') {
    return <ShimmerLine message="Loading explanation…" />
  }

  if (resolved === null) {
    return fallback ?? <Text dimColor>No explanation available</Text>
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text>{resolved.explanation}</Text>
      <Text>{resolved.reasoning}</Text>
      <Text>
        <Text color={RISK_COLOR[resolved.riskLevel]}>{RISK_LABEL[resolved.riskLevel]}</Text>
        {`: ${resolved.risk}`}
      </Text>
    </Box>
  )
}
