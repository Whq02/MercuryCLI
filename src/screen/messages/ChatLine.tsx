import * as React from 'react'
import { Text } from '../themedRenderer.js'
import { FAINT } from '../theme/mercuryPalette.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'


const CLOCK_SLOT = '         '

export function MercuryStreamingNameplate(): React.ReactNode {
  const critter = useSessionAccent()
  return (
    <Text>
      {CLOCK_SLOT}
      <Text color={FAINT}>[</Text>
      <Text color={critter.accent}>Mercury</Text>
      <Text color={FAINT}>] </Text>
    </Text>
  )
}
