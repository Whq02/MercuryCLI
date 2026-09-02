// ============================================================================
//  useSessionTitleMint — the VISIBLE process's one-time title mint (session-
//  aware naming, L16, stage 3): at a session's SECOND assistant turn the
//  watch mints a short title through the estate's existing small call and
//  stores it through the daemon's set-title door — once per session ever,
//  filling an empty title only (a typed name always survives; a mint that
//  cannot run leaves stage 2 standing). Mounted beside the ping engine in
//  every world — the tag's name matters in `--chat` most of all (the
//  operator's own catch: "it still says 'concourse-w3'"). Workers never
//  mount this hook.
// ============================================================================
import { useEffect } from 'react'
import { startSessionTitleMintWatch } from '../services/concourse/sessionTitleMint.js'

export function useSessionTitleMint(): void {
  useEffect(() => {
    const handle = startSessionTitleMintWatch()
    return () => handle.dispose()
  }, [])
}
