import * as React from 'react'
import { exitChordNoticeText } from '../../components/PromptInput/ExitChordNotice.js'
import { useEffect, useState } from 'react'

import { Box, Text, useInput } from '../../ink.js'

import { Select } from '../../components/CustomSelect/select.js'
import { Spinner } from '../../components/Spinner.js'
import { Panel } from '../../components/mercury-ui/components.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import {
  detectPythonPackageManager,
  getPythonApiInstructions,
  installIt2,
  markIt2SetupComplete,
  setPreferTmuxOverIterm2,
  verifyIt2Setup,
  type PythonPackageManager,
} from './backends/it2Setup.js'

/**
 * Interactive setup flow for `it2` (install / use tmux / cancel). A small
 * state machine; the `verify-api` step member is part of the step type but
 * unused, as shipped.
 */

type SetupStep =
  | 'initial'
  | 'installing'
  | 'install-failed'
  | 'api-instructions'
  | 'verifying'
  | 'verify-api'
  | 'success'
  | 'failed'

const MANUAL_INSTALL_COMMANDS: Record<PythonPackageManager, string> = {
  uvx: 'uv tool install it2',
  pipx: 'pipx install it2',
  pip: 'pip install --user it2',
}

const MANAGER_DISPLAY: Record<PythonPackageManager, string> = {
  uvx: 'uv',
  pipx: 'pipx',
  pip: 'pip',
}

export function It2SetupPrompt({
  onDone,
  tmuxAvailable,
}: {
  onDone: (result: 'installed' | 'use-tmux' | 'cancelled') => void
  tmuxAvailable: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [step, setStep] = useState<SetupStep>('initial')
  const [packageManager, setPackageManager] = useState<PythonPackageManager | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Detected once on mount; null only changes wording.
  useEffect(() => {
    void detectPythonPackageManager().then(setPackageManager)
  }, [])

  // An in-flight subprocess must not be abandoned mid-way.
  const busy = step === 'installing' || step === 'verifying'

  const exitState = useExitOnCtrlCD(useKeybindings)

  useKeybinding(
    'confirm:no',
    () => {
      onDone('cancelled')
    },
    { context: 'Confirmation', isActive: !busy },
  )

  const runVerification = async (): Promise<void> => {
    setStep('verifying')
    const result = await verifyIt2Setup()
    if (result.success) {
      markIt2SetupComplete()
      setStep('success')
      // The confirmation stays readable before the flow completes.
      setTimeout(() => onDone('installed'), 1500)
      return
    }
    setError(result.error ?? 'verification failed')
    setStep('failed')
  }

  const runInstall = async (): Promise<void> => {
    if (packageManager === null) {
      setError('No Python package manager was found — install uv, pipx, or pip first')
      setStep('failed')
      return
    }
    setStep('installing')
    const result = await installIt2(packageManager)
    if (result.success) {
      setStep('api-instructions')
      return
    }
    setError(result.error ?? 'installation failed')
    setStep('install-failed')
  }

  const useTmuxInstead = (): void => {
    setPreferTmuxOverIterm2(true)
    onDone('use-tmux')
  }

  useInput(
    (_input, key) => {
      if (key.return) void runVerification()
    },
    { isActive: step === 'api-instructions' },
  )

  const dispatchSelection = (value: string): void => {
    if (value === 'install') void runInstall()
    else if (value === 'retry-verify') void runVerification()
    else if (value === 'use-tmux') useTmuxInstead()
    else onDone('cancelled')
  }

  const tailOptions = [
    ...(tmuxAvailable ? [{ label: 'Use tmux instead', value: 'use-tmux' }] : []),
    { label: 'Cancel', value: 'cancel' },
  ]

  const installDescription =
    packageManager !== null
      ? `Install with ${MANAGER_DISPLAY[packageManager]}`
      : 'Requires Python (uv, pipx, or pip)'

  let body: React.ReactNode
  if (step === 'initial') {
    body = (
      <Box flexDirection="column" gap={1}>
        <Text>
          Native iTerm2 split panes need the <Text bold>it2</Text> CLI, which is not set up yet.
        </Text>
        <Select
          options={[
            { label: 'Install it2', value: 'install', description: installDescription },
            ...tailOptions,
          ]}
          onChange={dispatchSelection}
          onCancel={() => onDone('cancelled')}
        />
      </Box>
    )
  } else if (step === 'installing') {
    body = (
      <Box>
        <Spinner />
        <Text> Installing it2…</Text>
      </Box>
    )
  } else if (step === 'install-failed') {
    body = (
      <Box flexDirection="column" gap={1}>
        <Text color={tokens.failure}>Installation failed: {error}</Text>
        {packageManager !== null ? (
          <Text>
            You can install it manually with: <Text bold>{MANUAL_INSTALL_COMMANDS[packageManager]}</Text>
          </Text>
        ) : null}
        <Select
          options={[
            { label: 'Retry the install', value: 'install', description: installDescription },
            ...tailOptions,
          ]}
          onChange={dispatchSelection}
          onCancel={() => onDone('cancelled')}
        />
      </Box>
    )
  } else if (step === 'api-instructions') {
    body = (
      <Box flexDirection="column" gap={1}>
        <Text color={tokens.success}>it2 installed.</Text>
        <Box flexDirection="column">
          {getPythonApiInstructions().map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
        <Text>
          Press <Text bold>Enter</Text> to verify the connection.
        </Text>
      </Box>
    )
  } else if (step === 'verifying') {
    body = (
      <Box>
        <Spinner />
        <Text> Verifying the iTerm2 connection…</Text>
      </Box>
    )
  } else if (step === 'success') {
    body = <Text color={tokens.success}>it2 is set up — iTerm2 split panes are ready.</Text>
  } else {
    body = (
      <Box flexDirection="column" gap={1}>
        <Text color={tokens.failure}>Verification failed: {error}</Text>
        <Text>Make sure the Python API is enabled in iTerm2 preferences.</Text>
        <Text>iTerm2 may need to be restarted after enabling it.</Text>
        <Select
          options={[
            { label: 'Retry the verification', value: 'retry-verify' },
            ...tailOptions,
          ]}
          onChange={dispatchSelection}
          onCancel={() => onDone('cancelled')}
        />
      </Box>
    )
  }

  const showHint = step !== 'installing' && step !== 'verifying' && step !== 'success'

  return (
    <Box flexDirection="column">
      <Panel title="Set up iTerm2 split panes" accentBorder>
        {body}
      </Panel>
      {showHint ? (
        <Text color={tokens.textMuted}>
          {exitState.pending
            ? exitChordNoticeText(exitState.keyName)
            : 'n / esc to cancel'}
        </Text>
      ) : null}
    </Box>
  )
}
