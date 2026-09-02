import { toString as qrToString } from 'qrcode'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { FAINT, IVORY, TERRA } from '../../components/mercury-ui/theme.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useAppState, type AppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'

type Props = {
  onDone: () => void
}

// Shared QR-generation hook so both the Mercury shell and the base Pane render
// the same real data (remoteSessionUrl from AppState → QR of the real URL).
function useRemoteSessionQr(remoteSessionUrl: string | undefined): string {
  const [qrCode, setQrCode] = useState<string>('')

  useEffect(() => {
    if (!remoteSessionUrl) return

    const url = remoteSessionUrl
    async function generateQRCode(): Promise<void> {
      const qr = await qrToString(url, {
        type: 'utf8',
        errorCorrectionLevel: 'L',
      })
      setQrCode(qr)
    }
    // Intentionally silent fail - URL is still shown so QR is non-critical
    generateQRCode().catch(e => {
      logForDebugging('QR code generation failed', e)
    })
  }, [remoteSessionUrl])

  return qrCode
}

// Warm-ink CommandCenter rendering of the remote-session info. Same real
// data + same esc-to-close contract as the base Pane; CommandCenter binds esc.
function MercurySessionInfo({ onDone }: Props): React.ReactNode {
  const remoteSessionUrl = useAppState((s: AppState) => s.remoteSessionUrl)
  const qrCode = useRemoteSessionQr(remoteSessionUrl)

  if (!remoteSessionUrl) {
    return (
      <CommandCenter view="session" onClose={onDone}>
        <Box marginTop={1}>
          <Text color={IVORY}>
            Not in remote mode. Start with <Text color={TERRA}>claude --remote</Text> to use this
            command.
          </Text>
        </Box>
      </CommandCenter>
    )
  }

  const lines = qrCode.split('\n').filter(line => line.length > 0)
  const isLoading = lines.length === 0

  return (
    <CommandCenter view="session" subtitle="remote session" onClose={onDone}>
      <Box flexDirection="column" marginTop={1}>
        {isLoading ? (
          <Text color={FAINT}>Generating QR code…</Text>
        ) : (
          lines.map((line, i) => (
            <Text key={i} color={IVORY}>
              {line}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={FAINT}>Open in browser: </Text>
        <Text color={TERRA}>{remoteSessionUrl}</Text>
      </Box>
    </CommandCenter>
  )
}

function SessionInfo({ onDone }: Props): React.ReactNode {
  const remoteSessionUrl = useAppState((s: AppState) => s.remoteSessionUrl)
  const qrCode = useRemoteSessionQr(remoteSessionUrl)

  // Handle ESC to dismiss
  useKeybinding('confirm:no', onDone, { context: 'Confirmation' })

  return <MercurySessionInfo onDone={onDone} />
}

export const call: LocalJSXCommandCall = async onDone => {
  return <SessionInfo onDone={onDone} />
}
