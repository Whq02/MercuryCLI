import * as React from 'react'
import {
  MercuryPermissionsPanel,
  type Gate,
} from '../../components/MercuryPermissionsPanel.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import { substrateSnapshot } from '../../utils/cockpit/index.js'
import { listFeatureToggles, setFeatureToggle, isFeatureToggleOn } from '../../utils/featureToggles.js'

function AuthorityPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const mode = useAppState(
    (s: { toolPermissionContext?: { mode?: string } }) =>
      s?.toolPermissionContext?.mode,
  )
  const setAppState = useSetAppState()

  const sub = substrateSnapshot()
  const gates: Gate[] = (
    sub.data.sections.find(s => s.title === 'Security')?.rows ?? []
  ).map(r => ({
    key: r.name,
    label: r.name,
    on: r.on,
    flag: r.hint,
    danger: /kill/i.test(r.name),
  }))

  const features = listFeatureToggles()

  const onToggleFeature = (key: string): boolean => {
    const next = !isFeatureToggleOn(key)
    setFeatureToggle(key, next)
    return next
  }

  const onBypassChange = (on: boolean): void => {
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: on ? 'sovereign' : 'default',
      },
    }))
  }

  return (
    <MercuryPermissionsPanel
      gates={gates}
      features={features}
      onToggleFeature={onToggleFeature}
      initialBypass={modeBypassesPermissions((mode ?? 'default') as PermissionMode)}
      onBypassChange={onBypassChange}
      onClose={onClose}
    />
  )
}

export const call: LocalJSXCommandCall = async onDone => (
  <AuthorityPanel onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
)
