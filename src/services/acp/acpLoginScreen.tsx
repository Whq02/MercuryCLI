import React, { useState } from 'react'
import { writeSync } from 'node:fs'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { AMBER, SECOND } from '../../components/mercuryPalette.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { Box, Text } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { ACP_LOGIN_FLAG } from './acpSignIn.js'

const ACP_LOGIN_INTRO = 'Sign in to use Mercury from your editor; this window closes when you are done.'

type LoginOutcome = { ok: true; receipt?: string } | { ok: false; receipt?: string }

function AcpLoginScreen({ onSettled }: { onSettled: (outcome: LoginOutcome) => void }): React.ReactNode {
  const [epoch, setEpoch] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  return (
    <Box flexDirection="column">
      <ConsoleOAuthFlow
        key={epoch}
        startingMessage={ACP_LOGIN_INTRO}
        onDone={() => onSettled({ ok: true })}
        onCancel={() => onSettled({ ok: false })}
        onAbandonLeg={() => setEpoch(current => current + 1)}
        onOpenaiDone={result => {
          if (result.ok) {
            onSettled({ ok: true, receipt: result.receipt })
            return
          }
          setNote(result.receipt)
          setEpoch(current => current + 1)
        }}
      />
      {note !== null ? (
        <Text wrap="wrap">
          <Text color={AMBER}>{`${GLYPH.warn} `}</Text>
          <Text color={SECOND}>{note}</Text>
        </Text>
      ) : null}
    </Box>
  )
}

export async function runAcpLoginScreen(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    try {
      writeSync(2, `mercury acp ${ACP_LOGIN_FLAG} needs a terminal.\n`)
    } catch {
    }
    process.exit(2)
  }
  const { createRoot } = await import('../../ink.js')
  const root = await createRoot()
  const outcome = await new Promise<LoginOutcome>(resolve => {
    root.render(
      <AppStateProvider onChangeAppState={onChangeAppState}>
        <KeybindingSetup>
          <AcpLoginScreen onSettled={resolve} />
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
  root.unmount()
  try {
    writeSync(outcome.ok ? 1 : 2, `${outcome.receipt ?? (outcome.ok ? 'Signed in' : 'Sign-in closed — no credential changed')}\n`)
  } catch {
  }
  process.exit(outcome.ok ? 0 : 1)
}
