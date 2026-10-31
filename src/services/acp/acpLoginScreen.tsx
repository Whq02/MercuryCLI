import React, { useState } from 'react'
import { writeSync } from 'node:fs'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { AMBER, SECOND } from '../../components/mercuryPalette.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { MercurySetupFrame } from '../../components/MercurySetupFrame.js'
import { Box, Text } from '../../ink.js'
import { SetupScreenHost } from '../../interactiveHelpers.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { ACP_LOGIN_FLAG } from './acpSignIn.js'

export const ACP_LOGIN_INTRO = 'Sign in to use Mercury from your editor; this window closes when you are done.'
export const ACP_LOGIN_FOOTER = '↑↓ move · ↵ choose · esc closes'
export const ACP_LOGIN_CLOSED_RECEIPT = 'Sign-in closed — no credential changed'

type AcpLoginOutcome = { ok: true; receipt?: string } | { ok: false; receipt?: string }

function AcpLoginScreen({ onSettled }: { onSettled: (outcome: AcpLoginOutcome) => void }): React.ReactNode {
  const [epoch, setEpoch] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  return (
    <MercurySetupFrame title="editor sign-in" steps={[{ key: 'sign-in', label: 'sign in', state: 'current' }]} firstRunCard footer={ACP_LOGIN_FOOTER}>
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
    </MercurySetupFrame>
  )
}

export function acpLoginElement(onSettled: (outcome: AcpLoginOutcome) => void): React.ReactNode {
  return (
    <AppStateProvider onChangeAppState={onChangeAppState}>
      <KeybindingSetup>
        <SetupScreenHost>
          <AcpLoginScreen onSettled={onSettled} />
        </SetupScreenHost>
      </KeybindingSetup>
    </AppStateProvider>
  )
}

function acpLoginReceipt(outcome: AcpLoginOutcome): string {
  return outcome.receipt ?? (outcome.ok ? 'Signed in' : ACP_LOGIN_CLOSED_RECEIPT)
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
  const outcome = await new Promise<AcpLoginOutcome>(resolve => {
    root.render(acpLoginElement(resolve))
  })
  root.unmount()
  try {
    writeSync(outcome.ok ? 1 : 2, `${acpLoginReceipt(outcome)}\n`)
  } catch {
  }
  process.exit(outcome.ok ? 0 : 1)
}
