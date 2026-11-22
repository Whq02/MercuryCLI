import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { HOOK_EVENTS, type HookEvent } from '../../utils/hooks/contract.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { listHooks, type HookRow } from '../../utils/hooks/hooksSettings.js'
import {
  eventHasMatch,
  groupHooksByEventAndMatch,
  hookEventCards,
  hooksForMatch,
  sortedMatchesForEvent,
} from '../../utils/hooks/hooksConfigManager.js'
import { hooksDisabled, managedHooksOnly } from '../../utils/hooks/hooksConfigSnapshot.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsFilePathForSource,
  getSettingsForSource,
} from '../../utils/settings/settings.js'
import { toTildePath } from '../../utils/path.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { SelectEventMode } from './SelectEventMode.js'
import { SelectMatcherMode } from './SelectMatcherMode.js'
import { SelectHookMode } from './SelectHookMode.js'
import { ViewHookMode } from './ViewHookMode.js'
import { notBuilt } from '../../pi/holes.js'

type Mode =
  | { id: 'select-event' }
  | { id: 'select-match'; event: HookEvent }
  | { id: 'select-hook'; event: HookEvent; match: string }
  | { id: 'view-hook'; event: HookEvent; match: string; hook: HookRow }

function readPolicyAnswers(): { policyDisablesAll: boolean; managedOnly: boolean } {
  return {
    policyDisablesAll: getSettingsForSource('policySettings')?.events?.disabled === true,
    managedOnly: managedHooksOnly(),
  }
}

export function HooksConfigMenu(arg0: {
  toolNames: string[]
  onExit: LocalJSXCommandOnDone
}): React.ReactNode {
  return notBuilt('src/components/hooks/HooksConfigMenu.tsx:42')
}
