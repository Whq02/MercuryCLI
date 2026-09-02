import { useState } from 'react'
import { currentInputEventSeq } from '../../ink/events/input-event.js'

// The open-event gate, as ONE seam. A panel opened by a keystroke must not
// let the LAUNCHING keystroke act on row 0 / seed its query — but no key
// pressed AFTER the opener may ever be swallowed. Two prior generations of
// this seam were both wrong in one direction:
//
//   1. setTimeout→setState flag — the commit could park across an idle
//      stretch and swallow the first real keypress for seconds (the
//      idle-parked-commits arm of STALE-PAINT, the recorded class).
//   2. wall-clock mount comparator (Date.now() - mountedAt > 120-150ms) —
//      deterministic, but it swallowed a LEGITIMATE fast first key: a
//      printable typed within the window after opening was dropped
//      (mercury-feel DoD: "a printable key pressed immediately after
//      opening appears exactly once").
//
// This generation is EVENT-IDENTITY, not time: every InputEvent carries a
// process-monotonic seq (stamped at construction, src/ink/events/
// input-event.ts). The gate captures the seq current at MOUNT — i.e. the
// seq of the event whose dispatch opened the panel — and passes exactly
// the events constructed after it. The opener (and any same-event
// re-dispatch) is filtered; the very next keypress lands, even 0ms later.
//
// Doctrine (useSpecimenNav / HealthCertificate): esc + arrows respond
// IMMEDIATELY — gate only the keys that ACT (↵, letter actions, text entry
// where the launching chord's tail would leak into the query).
export function useOpenEventGate(): () => boolean {
  // useState initializer (not useRef) so StrictMode double-invoke stays
  // harmless and the capture is exactly-once per mount.
  const [openSeq] = useState(() => currentInputEventSeq())
  return () => currentInputEventSeq() > openSeq
}
