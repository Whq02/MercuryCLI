// ============================================================================
//  legalNotice — the ONE owner of Mercury's NOTICE stamp (LANE LW
//  deliverable 2).
//
//  The stamp is the comment block at the head of every built JS artifact
//  (dist/mercury.mjs, dist/verify-artifact.mjs — build.ts applies it and
//  self-checks it; scripts/distribution/prove-notice-stamp.ts gates that dist
//  output carries the CURRENT composition). The generated
//  THIRD_PARTY_NOTICES.md renders the same slots at its head, so the archive
//  NOTICES.md and the bundle header can never disagree.
//
//  THE TEXT CONSTRAINT (binding, from the lane brief): the operator drafts
//  all licence wording themselves. The two constants below are NAMED SLOTS —
//  while null, the stamp simply omits those lines; this file NEVER carries
//  placeholder or model-authored licence text. Filling a slot is one edit
//  here; the stamp gate then forces a rebuild so a stale artifact cannot
//  ship the old head.
//
//  Deterministic by construction: the stamp is a pure function of the
//  version + the slots (no dates), so reproducible-build oracles
//  (MERCURY_BUILD_MINIFY=oracle byte-comparison proofs) are unaffected.
// ============================================================================

/** NAMED SLOT — the Mercury copyright line. Operator-drafted; null until
 *  the draft lands (the stamp omits the line while null). */
export const MERCURY_COPYRIGHT_LINE: string | null = null

/** NAMED SLOT — the licence pointer line (what licence applies and where its
 *  text lives). Operator-drafted; null until the draft lands. */
export const MERCURY_LICENSE_POINTER: string | null = null

export interface NoticeSlots {
  copyrightLine: string | null
  licensePointer: string | null
}

export const CURRENT_NOTICE_SLOTS: NoticeSlots = {
  copyrightLine: MERCURY_COPYRIGHT_LINE,
  licensePointer: MERCURY_LICENSE_POINTER,
}

const RULE = '// ' + '═'.repeat(75)

/** Compose the NOTICE stamp for one artifact version. Pure; `slots` defaults
 *  to the repository's current named slots and is parameterized only so the
 *  stamp gate can prove both the omitted-line and rendered-line arms. */
export function composeNoticeStamp(version: string, slots: NoticeSlots = CURRENT_NOTICE_SLOTS): string {
  const lines = [
    RULE,
    `// Mercury ${version} — NOTICE`,
    ...(slots.copyrightLine ? [`// ${slots.copyrightLine}`] : []),
    ...(slots.licensePointer ? [`// ${slots.licensePointer}`] : []),
    '// Third-party components and licence attributions: NOTICES.md ships in every',
    '// release archive; THIRD_PARTY_NOTICES.md is the source-tree inventory.',
    RULE,
  ]
  return lines.join('\n') + '\n'
}

/** Apply the stamp to emitted artifact source — shebang-safe (the stamp goes
 *  after a #! first line, which must stay byte 0 for the OS loader). */
export function stampNoticeOnSource(source: string, version: string, slots: NoticeSlots = CURRENT_NOTICE_SLOTS): string {
  const stamp = composeNoticeStamp(version, slots)
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n')
    if (nl !== -1) return source.slice(0, nl + 1) + stamp + source.slice(nl + 1)
  }
  return stamp + source
}

/** Does this artifact text carry the CURRENT stamp (composition law + live
 *  slot values) at its head? The gate's one question. */
export function hasCurrentNoticeStamp(source: string, version: string, slots: NoticeSlots = CURRENT_NOTICE_SLOTS): boolean {
  const stamp = composeNoticeStamp(version, slots)
  if (source.startsWith(stamp)) return true
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n')
    if (nl !== -1) return source.slice(nl + 1).startsWith(stamp)
  }
  return false
}
