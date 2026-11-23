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
  const [status, setStatus] = useState<'pending' | 'done'>('pending')
  const [result, setResult] = useState<PermissionExplanation | null>(null)

  useLoad(signal => {
    if (!promise) return
    setStatus('pending')
    setResult(null)
    promise.catch(passedOverAs(null)).then(value => {
      if (signal.aborted) return
      setResult(value)
      setStatus('done')
    })
  }, [promise])

  if (!visible || !promise) return null

  if (status === 'pending') {
    return (
      <Box marginTop={1}>
        <ShimmerLine message="Explaining…" />
      </Box>
    )
  }

  if (result === null) {
    return (
      <Box marginTop={1}>
        {fallback ?? <Text dimColor>No explanation available</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{result.explanation}</Text>
      <Text dimColor>{result.reasoning}</Text>
      <Text>
        <Text color={RISK_COLOR[result.riskLevel]}>{RISK_LABEL[result.riskLevel]}</Text>
        {`: ${result.risk}`}
      </Text>
    </Box>
  )
}
