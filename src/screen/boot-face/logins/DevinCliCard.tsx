import React, { useRef, useState } from 'react'
import { useClaim } from '../../effects/effects.js'
import { Select } from '../../select/index.js'
import { Box, Text, useInput } from '../../themedRenderer.js'
import {
  DEVIN_CLI_ACTION_TITLE,
  devinCliActionOptions,
  devinCliLogoutConfirmOptions,
  runDevinCliAction,
  type DevinCliAction,
  type DevinCliRunOutcome,
} from './devinCliAction.js'

type CardState =
  | { kind: 'menu' }
  | { kind: 'confirm-logout' }
  | { kind: 'running'; action: DevinCliAction }
  | { kind: 'receipt'; outcome: DevinCliRunOutcome }

export function DevinCliCard({
  compact,
  onBack,
}: {
  compact: boolean
  onBack: () => void
}): React.ReactNode {
  const [state, setState] = useState<CardState>({ kind: 'menu' })
  const runRef = useRef(0)
  const mountedRef = useRef(true)

  useClaim(() => () => {
    mountedRef.current = false
    runRef.current += 1
  }, [])

  const startAction = (action: DevinCliAction): void => {
    const id = (runRef.current += 1)
    setState({ kind: 'running', action })
    void runDevinCliAction(action).then(outcome => {
      if (!mountedRef.current || runRef.current !== id) return
      setState({ kind: 'receipt', outcome })
    })
  }

  useInput(
    (_input, key, event) => {
      if (state.kind === 'receipt' && (key.return || key.escape)) {
        event.stopImmediatePropagation()
        setState({ kind: 'menu' })
      }
    },
    { isActive: state.kind === 'receipt' },
  )

  if (state.kind === 'confirm-logout') {
    return (
      <Box flexDirection="column" gap={compact ? 0 : 1}>
        <Text bold>{DEVIN_CLI_ACTION_TITLE}</Text>
        <Text wrap="wrap">Sign out of Devin CLI? This runs devin auth logout and removes Devin CLI credentials.</Text>
        <Select
          options={devinCliLogoutConfirmOptions()}
          onChange={value => {
            if (value === 'confirm') startAction('logout')
            else setState({ kind: 'menu' })
          }}
          onCancel={() => setState({ kind: 'menu' })}
        />
      </Box>
    )
  }

  if (state.kind === 'running') {
    return (
      <Box flexDirection="column" gap={compact ? 0 : 1}>
        <Text bold>{DEVIN_CLI_ACTION_TITLE}</Text>
        <Text>{`Running devin auth ${state.action} in your terminal…`}</Text>
      </Box>
    )
  }

  if (state.kind === 'receipt') {
    return (
      <Box flexDirection="column" gap={compact ? 0 : 1}>
        <Text bold>{DEVIN_CLI_ACTION_TITLE}</Text>
        <Text wrap="wrap">{state.outcome.receipt}</Text>
        <Text dimColor>press Enter or Esc to return</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={compact ? 0 : 1}>
      <Text bold>{DEVIN_CLI_ACTION_TITLE}</Text>
      {compact ? null : (
        <Text dimColor wrap="wrap">
          External agent — not a model provider for /model. Credentials stay with Devin CLI; attach via /crew attach devin.
        </Text>
      )}
      <Select
        options={devinCliActionOptions()}
        onChange={value => {
          if (value === 'logout') {
            setState({ kind: 'confirm-logout' })
            return
          }
          startAction(value)
        }}
        onCancel={onBack}
      />
    </Box>
  )
}
