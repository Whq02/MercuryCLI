
export const MERCURY_COPYRIGHT_LINE: string | null = null

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

export function stampNoticeOnSource(source: string, version: string, slots: NoticeSlots = CURRENT_NOTICE_SLOTS): string {
  const stamp = composeNoticeStamp(version, slots)
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n')
    if (nl !== -1) return source.slice(0, nl + 1) + stamp + source.slice(nl + 1)
  }
  return stamp + source
}

export function hasCurrentNoticeStamp(source: string, version: string, slots: NoticeSlots = CURRENT_NOTICE_SLOTS): boolean {
  const stamp = composeNoticeStamp(version, slots)
  if (source.startsWith(stamp)) return true
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n')
    if (nl !== -1) return source.slice(nl + 1).startsWith(stamp)
  }
  return false
}
