import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { ShimmerChar } from '../Spinner/ShimmerChar.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { Message } from '../../types/message.js'
import {
  generatePermissionExplanation,
  isPermissionExplainerEnabled,
  type PermissionExplanation,
  type RiskLevel,
} from '../../utils/permissions/permissionExplainer.js'

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

/**
 * The ctrl+e on-demand explanation for the shell consent cards.
 *
 * The generation request is created lazily on FIRST activation — never at
 * mount — so a user who never presses the key never spends tokens, and it is
 * created once per dialog: toggling visibility off and on re-uses the same
 * in-flight or resolved request. The request never rejects; every failure
 * resolves to null ("no explanation").
 */
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
  const requestRef = useRef<Promise<PermissionExplanation | null> | null>(null)

  useKeybinding(
    'confirm:toggleExplanation',
    () => {
      if (!requestRef.current) {
        requestRef.current = generatePermissionExplanation({
          toolName,
          toolInput,
          toolDescription,
          messages,
          // Deliberately never fired — the request runs to completion even if
          // the user toggles the pane away.
          signal: new AbortController().signal,
        }).catch(() => null)
        setPromise(requestRef.current)
      }
      setVisible(current => !current)
    },
    { context: 'Confirmation', isActive: enabled },
  )

  return { visible, enabled, promise }
}

/** The shimmering "thinking" line: one ShimmerChar per character, a travelling glimmer. */
function ShimmerLine({ message }: { message: string }): React.ReactNode {
  const [sweep, setSweep] = useState(0)
  useEffect(() => {
    const cycle = message.length + 10
    const timer = setInterval(() => setSweep(current => (current + 1) % cycle), 60)
    return () => clearInterval(timer)
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
}: {
  visible: boolean
  promise: Promise<PermissionExplanation | null> | null
}): React.ReactNode {
  const [resolved, setResolved] = useState<PermissionExplanation | null | 'pending'>('pending')
  useEffect(() => {
    if (!promise) return
    let cancelled = false
    setResolved('pending')
    void promise.then(result => {
      if (!cancelled) setResolved(result)
    })
    return () => {
      cancelled = true
    }
  }, [promise])

  if (!visible || !promise) return null
  if (resolved === 'pending') return <ShimmerLine message="Loading explanation…" />
  if (resolved === null) return <Text dimColor>No explanation available</Text>
  return (
    <Box flexDirection="column" gap={1}>
      <Text>{resolved.explanation}</Text>
      <Text>{resolved.reasoning}</Text>
      <Text>
        <Text color={RISK_COLOR[resolved.riskLevel]}>{RISK_LABEL[resolved.riskLevel]}</Text>:{' '}
        {resolved.risk}
      </Text>
    </Box>
  )
}
