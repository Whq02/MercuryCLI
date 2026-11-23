import * as React from 'react'
import { useRef, useState } from 'react'
import { Box, Text, useInput } from '../../../screen/themedRenderer.js'
import wrapText from '../../../screen/renderer/wrap-text.js'
import { useSignInEpoch } from '../account-ledger/useSignInEpoch.js'
import { useCatalogueEpoch } from '../../../screen/model-picker/useCatalogueEpoch.js'
import { useSetAppStateMaybe } from '../../../screen/app-state/AppState.js'
import { executeSlotRemoval, familyDisplayName } from '../../roads/accountSlots.js'
import { switchActiveSlot } from '../../roads/slotSwitch.js'
import { collectLoginsScreenFacts, loginsArmSlots, loginsCatalogue, loginsDetailLines, loginsRowStateOf, loginsSwitchableFamily } from '../../../screen/boot-face/BootLoginsScreen.js'
import { Select } from '../../../screen/select/index.js'
import type { LoginFamilyValue } from './loginFamilyRows.js'
import { usePopupCompact } from '../../../screen/overlays/popupFormContext.js'
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js'

export function LoginAccountCard({ family, onSignIn, onBack, onChanged }: { family: LoginFamilyValue; onSignIn: () => void; onBack: () => void; onChanged: (receipt: string) => void }): React.ReactNode {
  useSignInEpoch()
  useCatalogueEpoch()
  const { compact } = usePopupCompact()
  const { rows, columns } = useTerminalSize()
  const setAppState = useSetAppStateMaybe()
  const [version, setVersion] = useState(0)
  const [note, setNote] = useState('')
  const armed = useRef<{ id: string; at: number } | null>(null)
  void version
  const facts = collectLoginsScreenFacts()
  const arm = loginsCatalogue().find(candidate => candidate.row.value === family)!
  const slots = loginsArmSlots(arm, facts.groups.find(group => group.family.id === arm.familyId))
  const switchable = loginsSwitchableFamily(arm, facts)
  const refresh = (): void => {
    setVersion(value => value + 1)
    setAppState?.(state => ({ ...state, authVersion: (state.authVersion ?? 0) + 1 }))
  }
  const switchSlot = (): void => {
    if (!switchable) return
    armed.current = null
    const outcome = switchActiveSlot(switchable)
    setNote(outcome.receipt)
    if (outcome.switched) { onChanged(outcome.receipt); refresh() }
  }
  useInput((input, key, event) => {
    if (input !== 's' || key.ctrl || key.meta || !switchable) return
    event.stopImmediatePropagation()
    switchSlot()
  })
  const detail = loginsDetailLines(arm, facts)
  const state = loginsRowStateOf(arm, facts)
  const heading = `${detail[0]} · ${state.chip}`
  const headingRows = state.refusal ? wrapText(heading, Math.max(1, columns), 'wrap').split('\n').length : 1
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1}>
      <Box flexDirection="column">
        {compact ? <Text wrap={state.refusal ? 'wrap' : 'truncate-end'}>{heading}</Text> : detail.map((line, index) => <Text key={index}>{line || ' '}</Text>)}
      </Box>
      <Select
        visibleOptionCount={Math.max(1, Math.min(rows - headingRows, slots.length + 2))}
        options={[
          { label: 'Sign in / re-login', value: 'sign-in' },
          ...(switchable ? [{ label: 'Switch active slot', value: 'switch' }] : []),
          ...slots.map(slot => ({ label: `${slot.kind === 'api-key' ? 'Remove key' : 'Sign out'} — ${slot.identity || slot.kindLabel}`, value: slot.id })),
        ]}
        onFocus={() => { armed.current = null }}
        onChange={value => {
          if (value === 'sign-in') { onSignIn(); return }
          if (value === 'switch') { switchSlot(); return }
          const slot = slots.find(candidate => candidate.id === value)
          if (!slot) return
          const removable = !['excluded', 'owner', 'settings', 'env'].includes(slot.removal.route)
          if (removable && (armed.current?.id !== slot.id || Date.now() - armed.current.at > 8_000)) {
            armed.current = { id: slot.id, at: Date.now() }
            setNote(`Confirm again to remove ${familyDisplayName(slot.family)} · ${slot.identity || slot.kindLabel} (signs it out and drops the stored credential) — any other row keeps it`)
            return
          }
          armed.current = null
          const outcome = executeSlotRemoval(slot)
          setNote(outcome.note)
          if (outcome.mutated) { onChanged(outcome.note); refresh() }
        }}
        onCancel={onBack}
      />
      {note ? <Text>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}
