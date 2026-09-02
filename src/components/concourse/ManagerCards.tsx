import React, { useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { describeSeatReading } from '../../services/switchboard/capacityCheck.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'
import { Select, type OptionWithDescription } from '../CustomSelect/index.js'
import { askCardKeyAction, type ManagerAskV1, type ManagerPlanV1 } from '../../services/concourse/managerMode.js'
import { planCardLayout } from './planCardLayout.js'


const CUSTOM_VALUE = '__custom__'

export interface ManagerAskCardAnswer {
  text: string
}

export function ManagerAskCard({
  ask,
  focused,
  onAnswer,
  onEnough,
  onDismiss,
}: {
  ask: ManagerAskV1
  focused: boolean
  onAnswer: (text: string) => void
  onEnough: () => void
  onDismiss: (typedDraft?: string) => void
}): React.ReactNode {
  const t = useMercuryTokens()
  const [customText, setCustomText] = useState('')
  const [focusTarget, setFocusTarget] = useState<string | undefined>(undefined)
  const liveFocusRef = useRef<string | undefined>(undefined)

  const options = useMemo<OptionWithDescription<string>[]>(
    () => [
      ...ask.options.map(o => ({ type: 'text' as const, value: o, label: o })),
      {
        type: 'input' as const,
        value: CUSTOM_VALUE,
        label: 'your own answer',
        placeholder: 'your own answer',
        onChange: (value: string) => setCustomText(value),
        allowEmptySubmitToCancel: true,
      },
    ],
    [ask.options],
  )
  const customOrdinal = ask.options.length + 1
  const enoughOrdinal = ask.options.length + 2

  const commit = (value: string): void => {
    if (value === CUSTOM_VALUE) {
      const text = customText.trim()
      if (text.length === 0) return
      onAnswer(text)
      return
    }
    onAnswer(value)
  }

  const selectRow = (index: number): void => {
    const target = options[index]
    if (target === undefined) return
    setFocusTarget(String(target.value))
  }

  useInput(
    (input, _key, event) => {
      const action = askCardKeyAction(input, {
        optionCount: options.length,
        inInput: liveFocusRef.current === CUSTOM_VALUE,
      })
      if (action.kind === 'ignore') return
      event.stopImmediatePropagation()
      if (action.kind === 'select') {
        selectRow(action.index)
        return
      }
      onEnough()
    },
    { isActive: focused },
  )

  return (
    <Box flexDirection="column" flexShrink={0}>
      <PermissionDialog
        title={ask.index !== undefined ? `Manager interview · question ${ask.index}` : 'Manager interview'}
        color="info"
      >
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}>
            <Text bold wrap="wrap">
              {ask.question}
            </Text>
          </Box>
          <Box flexDirection="column" flexShrink={0} marginTop={1}>
            {
}
            <Select
              options={options}
              layout="compact-vertical"
              visibleOptionCount={options.length}
              disableSelection="numeric"
              isDisabled={!focused}
              {...(focusTarget !== undefined ? { defaultFocusValue: focusTarget } : {})}
              onFocus={value => {
                liveFocusRef.current = String(value)
                setFocusTarget(String(value))
              }}
              onChange={value => commit(String(value))}
              onCancel={() => onDismiss(customText.length > 0 ? customText : undefined)}
            />
          </Box>
          <Box height={1} flexShrink={0}>
            <InteractiveRow id="manager:ask:enough" directActivate hoverStyle="row-fill" onActivate={onEnough}>
              {hover => (
                <Text color={hover ? t.textPrimary : t.textSecondary} wrap="truncate-end">
                  {'  '}
                  {enoughOrdinal}. enough — plan it
                </Text>
              )}
            </InteractiveRow>
          </Box>
          <Box marginTop={1} flexShrink={0}>
            <Text color="subtle" wrap="truncate-end">
              {
}
              {`1–${ask.options.length} select · ↵ commit · ${customOrdinal} custom answer · esc close`}
            </Text>
          </Box>
        </Box>
      </PermissionDialog>
    </Box>
  )
}


type PlanAnswer = 'yes' | 'no'

export function ManagerPlanCard({
  plan,
  focused,
  busy,
  onYes,
  onNo,
  maxRows,
  textWidth,
}: {
  plan: ManagerPlanV1
  focused: boolean
  busy: boolean
  onYes: (supervision: 'supervising' | 'launch-only') => void
  onNo: () => void
  maxRows?: number
  textWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const [supervision, setSupervision] = useState<'supervising' | 'launch-only'>(plan.supervision)
  const layout = planCardLayout(plan, maxRows, Math.max(16, textWidth ?? 38))
  const lanesShown = plan.lanes.slice(0, layout.shown)
  const options = useMemo<PermissionPromptOption<PlanAnswer>[]>(
    () => [
      { label: `Yes — start the lane${plan.lanes.length === 1 ? '' : 's'}, each under its contract`, value: 'yes' },
      { label: 'No, keep the draft (esc)', value: 'no' },
    ],
    [plan.lanes.length],
  )
  useInput(
    (input, _key, event) => {
      if (input === 's' || input === 'S') {
        event.stopImmediatePropagation()
        setSupervision(v => (v === 'supervising' ? 'launch-only' : 'supervising'))
      }
    },
    { isActive: focused && !busy },
  )
  return (
    <Box flexDirection="column" flexShrink={0}>
      <PermissionDialog title="The manager's plan" color="info">
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}>
            <Text wrap="wrap">
              <Text bold>{plan.goal}</Text>
            </Text>
          </Box>
          {
}
          <Box
            flexDirection="column"
            flexShrink={0}
            {...(maxRows !== undefined ? { height: layout.lanesRows, overflow: 'hidden' as const } : {})}
          >
            {lanesShown.map((lane, i) =>
              layout.tier === 'titles' ? (
                <Box key={`${lane.title}:${i}`} height={1} flexShrink={0}>
                  <Text wrap="truncate-end">
                    <Text color={t.infoText} bold>
                      lane {i + 1} · {lane.title}
                    </Text>
                    <Text color={t.textMuted}> · </Text>
                    <Text color={t.warning}>{GLYPH.ownSubstrate}</Text>
                    <Text color={t.textPrimary}> {lane.territory}</Text>
                  </Text>
                </Box>
              ) : (
                <Box key={`${lane.title}:${i}`} flexDirection="column" flexShrink={0} marginTop={1}>
                  <Text wrap="truncate-end">
                    <Text color={t.infoText} bold>
                      lane {i + 1} · {lane.title}
                    </Text>
                  </Text>
                  {layout.tier === 'full' ? (
                    <>
                      <Text color={t.textSecondary} wrap="wrap">
                        {'  '}scope: {lane.scope}
                      </Text>
                      <Text color={t.textSecondary} wrap="wrap">
                        {'  '}delivers: {lane.deliverables}
                      </Text>
                    </>
                  ) : null}
                  {
}
                  <Text wrap="wrap">
                    {'  '}
                    <Text color={t.warning}>{GLYPH.ownSubstrate}</Text>
                    <Text color={t.textPrimary}> territory: {lane.territory}</Text>
                  </Text>
                </Box>
              ),
            )}
            {layout.hidden > 0 ? (
              <Box height={1} flexShrink={0}>
                <Text color={t.textMuted} wrap="truncate-end">
                  +{layout.hidden} more lane{layout.hidden === 1 ? '' : 's'} — not shown at this height; Yes starts all {plan.lanes.length}
                </Text>
              </Box>
            ) : null}
          </Box>
          {plan.seats !== undefined ? (
            <Box flexShrink={0} marginTop={1}>
              <Text color={t.textMuted} wrap="truncate-end">
                seats: {plan.seats}
              </Text>
            </Box>
          ) : null}
          <Box height={1} flexShrink={0} marginTop={plan.seats !== undefined ? 0 : 1}>
            <InteractiveRow
              id="manager:plan:supervision"
              directActivate
              hoverStyle="row-fill"
              onActivate={() => setSupervision(v => (v === 'supervising' ? 'launch-only' : 'supervising'))}
            >
              {hover => (
                <Text color={hover ? t.textPrimary : t.textSecondary} wrap="truncate-end">
                  {
}
                  after dispatch — s switches:{' '}
                  <Text color={supervision === 'supervising' ? t.infoText : t.textMuted} bold={supervision === 'supervising'}>
                    supervise
                  </Text>
                  {' · '}
                  <Text color={supervision === 'launch-only' ? t.infoText : t.textMuted} bold={supervision === 'launch-only'}>
                    launch-only
                  </Text>
                </Text>
              )}
            </InteractiveRow>
          </Box>
          {busy ? (
            <Box height={1} flexShrink={0} marginTop={1}>
              <Text color={t.textInstruction} wrap="truncate-end">
                dispatching the lanes — the receipts land below…
              </Text>
            </Box>
          ) : (
            <PermissionPrompt
              options={options}
              question="Dispatch this plan?"
              isDisabled={!focused}
              onSelect={value => (value === 'yes' ? onYes(supervision) : onNo())}
              onCancel={onNo}
            />

          )}
        </Box>
      </PermissionDialog>
    </Box>
  )
}


export function ManagerSeatAskCard({
  live,
  ceiling,
  lanes,
  focused,
  onAnswer,
}: {
  live: number
  ceiling: number
  lanes: number
  focused: boolean
  onAnswer: (allowed: boolean) => void
}): React.ReactNode {
  const options = useMemo<PermissionPromptOption<PlanAnswer>[]>(
    () => [
      { label: 'Yes — start what fits now; the rest start as seats free', value: 'yes' },
      { label: 'No, dispatch nothing (esc)', value: 'no' },
    ],
    [],
  )
  const fits = Math.max(0, Math.min(lanes, ceiling - live))
  return (
    <Box flexDirection="column" flexShrink={0}>
      <PermissionDialog title="Past the machine's reading">
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}>
            <Text wrap="wrap">
              <Text bold>{lanes} lane{lanes === 1 ? '' : 's'}</Text> over {describeSeatReading(ceiling)} with {live} live
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor wrap="wrap">
              the plan would run past the reading. Yes starts {fits === 0 ? 'none yet' : `${fits} now`} and holds
              the other {lanes - fits} in the plan — each starts under its own contract the moment a
              seat frees (never a queued first turn without its contract). No dispatches nothing
              — the plan card stays for editing.
            </Text>
          </Box>
          <PermissionPrompt
            options={options}
            isDisabled={!focused}
            onSelect={value => onAnswer(value === 'yes')}
            onCancel={() => onAnswer(false)}
          />
        </Box>
      </PermissionDialog>
    </Box>
  )
}
