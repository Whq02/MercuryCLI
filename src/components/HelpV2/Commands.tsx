import * as React from 'react'
import { useMemo, useState } from 'react'
import { useInput } from '../../ink.js'
import { type Command, formatDescriptionWithSource } from '../../commands.js'
import { Box, Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'
import { Select, type OptionWithDescription } from '../CustomSelect/select.js'
import { useTabHeaderFocus } from '../design-system/Tabs.js'
import { groupCommandsByDomain } from './commandDomains.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type Props = Unbuilt

export function Commands(arg0: Props): React.ReactNode {
  return notBuilt('src/components/HelpV2/Commands.tsx:21')
}
