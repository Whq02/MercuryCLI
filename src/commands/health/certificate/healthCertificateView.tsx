import * as React from 'react'
import { Box, Text } from '../../../screen/themedRenderer.js'
import type { DOMElement } from '../../../screen/themedRenderer.js'
import ScrollBox, { type ScrollBoxHandle } from '../../../screen/renderer/elements/ScrollBox.js'
import { PopupScrollViewport } from '../../../screen/select/popup-list.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../../screen/theme/mercuryPalette.js'
import { ProductLockup, SectionHeader, StateBadge } from '../../../screen/widgets/components.js'
import type { MercuryThemeTokens } from '../../../screen/theme/mercuryTokens.js'
import { HEALTH_STATUS_META, type nextActions, type HealthCertificate as Cert, type HealthCheck, type HealthSection, type HealthStatus } from '../../../platform/health/healthReport.js'
import type { AppliedFix } from '../../../platform/health/healthFix.js'
import type { healthPopupLayout } from '../HealthCertificate.js'

export type FixFlow =
  | { phase: 'confirm'; check: HealthCheck }
  | { phase: 'running'; check: HealthCheck }
  | { phase: 'done'; check: HealthCheck; outcome: AppliedFix }

export function healthCertificateView({
  tok,
  elevatedRef,
  width,
  innerW,
  ground,
  cert,
  loading,
  openId,
  fixFlow,
  checks,
  scrollRef,
  selRowRef,
  selectId,
  toggleOpen,
  selId,
  counts,
  meta,
  actions,
  sections,
  layout,
  footer,
  statusLine,
  statusColor,
  HEALTH_POPUP_VIEW,
  CheckRow,
  FixCard,
}: {
  tok: MercuryThemeTokens
  elevatedRef: (el: DOMElement | null) => void
  width: number
  innerW: number
  ground: string | undefined
  cert: Cert | null
  loading: boolean
  openId: string | null
  fixFlow: FixFlow | null
  checks: HealthCheck[]
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  selRowRef: React.RefObject<DOMElement | null>
  selectId: (id: string) => void
  toggleOpen: (id: string) => void
  selId: string | null
  counts: Record<HealthStatus, number> | null
  meta: { state: 'live' | 'gated' | 'failed'; label: string } | null
  actions: ReturnType<typeof nextActions>
  sections: HealthSection[]
  layout: ReturnType<typeof healthPopupLayout>
  footer: string
  statusLine: string | null
  statusColor: (status: HealthStatus) => string
  HEALTH_POPUP_VIEW: 'health'
  CheckRow: (props: { check: HealthCheck; active: boolean; open: boolean; width: number; rowRef?: React.Ref<DOMElement>; onSelect: () => void; onActivate: () => void }) => React.ReactNode
  FixCard: (props: { flow: FixFlow }) => React.ReactNode
}): React.ReactNode {
  return (
    <Box ref={elevatedRef} flexDirection="column" width={width} flexShrink={0} borderStyle="round" borderColor={tok.borderStrong} paddingX={1} opaque={true} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
      <Box flexDirection="row" height={1} overflow="hidden">
        <ProductLockup view={HEALTH_POPUP_VIEW} separator=" · " />
        {cert && meta ? (
          <Text wrap="truncate-end">
            <Text color={FAINT}> · </Text>
            <StateBadge state={meta.state} label={meta.label} />
          </Text>
        ) : null}
      </Box>
      {layout.compact ? null : (
        <Box height={1}>
          <Text color={loading ? FAINT : AMBER} wrap="truncate-end">{statusLine}</Text>
        </Box>
      )}
      {layout.compact ? null : (
        <Box height={1}>
          {counts ? (
            <Text color={FAINT} wrap="truncate-end">
              {checks.length} checks
              {counts.fail ? <Text color={CRIMSON}> · {counts.fail} fail</Text> : null}
              {counts.stale ? <Text color={AMBER}> · {counts.stale} stale</Text> : null}
              {counts.warn ? <Text color={AMBER}> · {counts.warn} warn</Text> : null}
              {counts.unknown ? <Text color={SECOND}> · {counts.unknown} unknown</Text> : null}
              {counts.ok ? <Text color={TEAL}> · {counts.ok} ok</Text> : null}
              {counts.off ? <Text color={FAINT}> · {counts.off} off</Text> : null}
              {counts.info ? <Text color={FAINT}> · {counts.info} info</Text> : null}
            </Text>
          ) : null}
        </Box>
      )}
      {layout.compact ? null : <Box height={1} />}
      {fixFlow ? (
        <Box flexDirection="column" maxHeight={layout.cardRows} overflow="hidden" flexShrink={0}>
          <FixCard flow={fixFlow} />
        </Box>
      ) : null}
      <PopupScrollViewport scrollRef={scrollRef}>{scrolls => {
      const listW = Math.max(1, innerW - (scrolls ? 1 : 0))
      return (
      <ScrollBox ref={scrollRef} height={layout.listRows} flexShrink={0} flexDirection="column">
        {layout.compact && statusLine !== null ? <Text color={loading ? FAINT : AMBER} wrap="truncate-end">{statusLine}</Text> : null}
        {actions.length > 0 ? (
          <Box flexDirection="column">
            <SectionHeader marginTop={0}>NEXT</SectionHeader>
            {actions.map((a, i) => (
              <Box key={i} flexDirection="row" width={listW}>
                <Box flexShrink={0}>
                  <Text color={statusColor(a.status)}>{HEALTH_STATUS_META[a.status].glyph} </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text color={IVORY} wrap="wrap">{a.fix}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        ) : null}
        {sections.map((section, sectionIndex) => (
          <Box key={section.id} flexDirection="column">
            <SectionHeader marginTop={sectionIndex === 0 && actions.length === 0 ? 0 : 1}>{section.title}</SectionHeader>
            {section.checks.map(c => (
                <CheckRow
                  key={c.id}
                  check={c}
                  active={selId === c.id}
                  open={openId === c.id}
                  width={listW}
                  rowRef={selId === c.id ? selRowRef : undefined}
                  onSelect={() => selectId(c.id)}
                  onActivate={() => toggleOpen(c.id)}
                />
            ))}
          </Box>
        ))}
      </ScrollBox>
      )}}</PopupScrollViewport>
      {layout.legend ? <Box height={1} /> : null}
      <Box height={1} width={innerW + 1} marginRight={-1}>
        <Text color={tok.textMuted} wrap="truncate-end">{footer}</Text>
      </Box>
    </Box>
  )
}
