import * as React from 'react'
import { createContext, useContext } from 'react'

/**
 * True for the subtree rendered INSIDE the Helm cockpit's center column (provided
 * by HelmHome only on its wide, rails-showing branch). Lets content in the center
 * (e.g. MercuryHome's welcome glance) know the cockpit rails are present WITHOUT
 * reading the terminal width — which HelmHome overrides (TerminalSizeContext) to
 * the narrower center column, so a `columns >= HELM_HOME_MIN_COLS` check inside the
 * center would mis-read. The narrow fallback provides no value → default `false` →
 * the rails are hidden → content keeps its own vitals (no data loss).
 */
export const CockpitActiveContext = createContext<boolean>(false)

/**
 * The non-cockpit placement gate for the working-status strip (spinner + turn
 * rollup, under-the-banner move): renders its children ONLY when
 * the cockpit is NOT active. FullscreenLayout provides the context AND owns
 * the cockpit placement (statusBand under the center header), so the strip
 * can never render twice — one context, both decisions.
 */
export function CockpitBottomStatus({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const cockpit = useContext(CockpitActiveContext)
  if (cockpit) return null
  return children
}
