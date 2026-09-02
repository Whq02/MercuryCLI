// ============================================================================
//  concourse/concourseEnabled — THE CONCOURSE SWITCH (the operator's
//  word): `mercury --concourse-off` turns
//  the concourse machinery off for this and every future bare boot; the
//  symmetric `--concourse-on` (or /config) turns it back on. DEFAULT ON.
//
//  A REGISTERED persisted config field (schema.ts `concourseEnabled`) —
//  SET, never heal-repainted: exactly two writers exist (the boot switch and
//  the /config row); no read path ever writes it back; an absent field
//  reads as ON. With it off, the boot never auto-enters the concourse, the
//  boot menu keeps its Projects road (the solo user's project road is the
//  boot menu — B1), the strip is the plain world — [boot menu] ⇄ [chat],
//  no concourse stop (the same world `--chat` gives one boot) — and the
//  boot menu's Session Concourse row (or /concourse) opens the plain LIVE
//  VIEW of the operator's sessions (rule 5's reduced stage: tiles, no
//  coordinator controls). Off is never a one-way door.
// ============================================================================
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

/** Is the concourse machinery on? Absent ⇒ on (the default). */
export function concourseEnabled(): boolean {
  try {
    return getGlobalConfig().concourseEnabled !== false
  } catch {
    return true
  }
}

/** The two writers' one door (the boot switch, the /config row). */
export function setConcourseEnabled(on: boolean): void {
  saveGlobalConfig(config => (config.concourseEnabled === on ? config : { ...config, concourseEnabled: on }))
}
