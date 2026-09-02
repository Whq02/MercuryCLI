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

// /authority — the dedicated MercuryPermissionsPanel (capability gates + feature
// toggles + bypass). Distinct from the base /permissions rule editor (kept
// intact, priority surface). The capability gates are a READ-ONLY reflection of
// substrateSnapshot; the feature toggles are Mercury features (five default-off + one default-on)
// whose gates re-read their env LIVE (featureToggles.ts), so ↵ genuinely flips
// behavior; the bypass toggle drives the REAL toolPermissionContext.mode, which
// lights the standing ▸▸ bypass badge in MercuryFrame. Never fabricated.
function AuthorityPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const mode = useAppState(
    (s: { toolPermissionContext?: { mode?: string } }) =>
      s?.toolPermissionContext?.mode,
  )
  const setAppState = useSetAppState()

  // Real capability gates (read-only reflection of the live substrate) — the
  // Security section EXACTLY, not a positional slice(0,6) of the flattened
  // sections (that silently dropped/gained rows whenever the snapshot grew).
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

  // The Mercury feature toggles (five default-off + one default-on), live on/off per gate.
  const features = listFeatureToggles()

  // ↵ on a feature row flips its env var in-process; the gate re-reads it live,
  // so the change is real (not fabricated). Returns the resulting state so the
  // panel can paint the new glyph immediately.
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
