import { stripTerminalControls } from '../../platform/text/strings.js'

type ExternalPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'

export interface ExternalPermissionOption {
  optionId: string
  name: string
  kind: ExternalPermissionOptionKind
}

export interface ExternalSeatPermissionAsk {
  kind: 'external-acp'
  askId: string
  seatId: string
  agentId?: string
  adapterKind: string
  displayName: string
  sessionId: string
  toolCallId: string
  title: string
  toolKind?: string
  targets: readonly string[]
  detail?: string
  cwd: string
  options: readonly ExternalPermissionOption[]
  askedAt: number
  onSelect: (optionId: string) => void
  onCancel: () => void
}

export function isExternalPermissionOptionKind(
  value: unknown,
): value is ExternalPermissionOptionKind {
  return (
    value === 'allow_once' ||
    value === 'allow_always' ||
    value === 'reject_once' ||
    value === 'reject_always'
  )
}

export function sanitizeExternalCardText(raw: string, maxLength: number): string {
  const cleaned = stripTerminalControls(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`
}
