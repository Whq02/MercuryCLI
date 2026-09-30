import * as React from 'react'
import { useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useSignInEpoch } from '../utils/accounts/useSignInEpoch.js'
import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js'
import { useSetAppStateMaybe } from '../state/AppState.js'
import { executeSlotRemoval, familyDisplayName } from '../services/providers/accountSlots.js'
import { switchActiveSlot } from '../services/providers/slotSwitch.js'
import { collectLoginsScreenFacts, loginsArmSlots, loginsCatalogue, loginsDetailLines, loginsSwitchableFamily } from './BootLoginsScreen.js'
import { Select } from './CustomSelect/index.js'
import type { LoginFamilyValue } from './loginFamilyRows.js'

export function LoginAccountCard({ family, onSignIn, onBack, onChanged }: { family: LoginFamilyValue; onSignIn: () => void; onBack: () => void; onChanged: (receipt: string) => void }): React.ReactNode {
  useSignInEpoch()
  useCatalogueEpoch()
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
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        {loginsDetailLines(arm, facts).map((line, index) => <Text key={index}>{line || ' '}</Text>)}
      </Box>
      <Select
        visibleOptionCount={slots.length + 2}
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
      <Text dimColor>esc back</Text>
    </Box>
  )
}
