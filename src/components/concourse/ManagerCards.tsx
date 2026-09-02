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

// ============================================================================
//  ManagerCards — manager mode's three cards (coordinator-tooling ledger
//  T7+T8), confined to the coordinator's REPL.
//
//  REUSE, never a lookalike (the SeatOverloadCard law): every card composes
//  the estate's real owners — PermissionDialog (the one consent frame), the
//  CustomSelect owner (the interview list: the QuestionView grammar —
//  compact-vertical, an input option for the custom answer), and
//  PermissionPrompt (the plan's Yes/No — the one consent option grammar).
//
//  THE RULED NUMBER-KEY SEMANTICS (T8, exact — they OVERRIDE the select
//  owner's digit-commit for these cards alone): pressing a number SELECTS
//  (highlights) its option and never advances; the custom option's number
//  selects AND focuses its input for typing; ↵ commits the highlighted
//  answer; clicking an option selects it (mouse parity). The mechanism:
//  the Select's own digits are off (disableSelection 'numeric') and the
//  card drives the owner's CONTROLLED focus door (defaultFocusValue),
//  mirroring live focus so every differing digit press is a real change.
// ============================================================================

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
  /** The coordinator panel holds focus — only then does the card own keys
   *  (the interview never imprisons the rest of the board). */
  focused: boolean
  /** Commit the highlighted answer (an option's text or the custom words) —
   *  it rides the one send door as the operator's next message. */
  onAnswer: (text: string) => void
  /** The always-available explicit exit (T8): "enough — plan it". */
  onEnough: () => void
  /** esc — the card closes; the interview stays in the conversation. The
   *  operator's typed-but-unsent custom words ride along so the composer
   *  can keep them (FC-062: esc used to take the question AND the typed
   *  answer off the screen together). */
  onDismiss: (typedDraft?: string) => void
}): React.ReactNode {
  const t = useMercuryTokens()
  const [customText, setCustomText] = useState('')
  // THE CONTROLLED FOCUS MIRROR: `focusTarget` rides the select owner's
  // defaultFocusValue; `liveFocus` mirrors the owner's own moves (arrows),
  // so a digit press always lands as a REAL prop change and re-asserts.
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
      // An empty custom ↵ commits nothing — the card stays; type the answer
      // (or pick a proposed one).
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

  // THE DIGIT LAW rides the ONE pure fold (askCardKeyAction — the prover
  // runs it): a digit SELECTS or fires the footer exit, never commits — a
  // digit on the already-selected option re-selects it and a double press
  // is never a commit shortcut; only ↵ (the owner's accept → onChange →
  // commit) commits. The select owner's own digits are off ('numeric').
  useInput(
    (input, _key, event) => {
      const action = askCardKeyAction(input, {
        optionCount: options.length,
        // Digits typed INTO the custom field are its text, never a move
        // (the field consumed them already; this is belt-and-braces).
        inInput: liveFocusRef.current === CUSTOM_VALUE,
      })
      if (action.kind === 'ignore') return
      event.stopImmediatePropagation()
      if (action.kind === 'select') {
        selectRow(action.index)
        return
      }
      // The advertised footer ordinal fires (the QuestionView footer
      // grammar: a painted digit that does nothing would advertise a lie)
      // — "enough — plan it" is an exit, not an option.
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
            {/* Mouse parity (T8) rides the Select's OWN per-option boxes
                now (D3 — MGR-5): the old localRow arithmetic here picked
                the wrong option the moment any option wrapped. */}
            <Select
              options={options}
              layout="compact-vertical"
              visibleOptionCount={options.length}
              disableSelection="numeric"
              isDisabled={!focused}
              {...(focusTarget !== undefined ? { defaultFocusValue: focusTarget } : {})}
              onFocus={value => {
                // The mirror keeps the controlled prop tracking the owner's
                // own moves (arrows), so a later digit press is always a
                // REAL prop change and re-asserts — without it, "press 2,
                // arrow to 3, press 2 again" would be a dead key.
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
              {/* FC-132: this row truncates its END — the keys ride in
                  load-bearing order so the cut eats esc (a convention)
                  before it eats select/commit/custom. */}
              {`1–${ask.options.length} select · ↵ commit · ${customOrdinal} custom answer · esc close`}
            </Text>
          </Box>
        </Box>
      </PermissionDialog>
    </Box>
  )
}

// ── the plan card (T8: the ONE consent) ─────────────────────────────────────

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
  /** The Yes is executing — the card stands quiet until the receipts land. */
  busy: boolean
  /** ONE Yes = contracts set + lanes dispatched (the seat-overload ask
   *  still rides past capacity at the caller — never bypassed). Carries the
   *  supervision the card shows at commit time. */
  onYes: (supervision: 'supervising' | 'launch-only') => void
  /** No/esc — the draft plan stays in the conversation for editing;
   *  nothing dispatches. */
  onNo: () => void
  /** THE HEIGHT BUDGET (MGR-1): the rows the host grants the whole card —
   *  the lanes block yields to fit, the consent prompt never does. */
  maxRows?: number
  /** The cells a wrapped line has inside the card (the host's pane width
   *  minus the frame's chrome). */
  textWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  // The supervision line (T8 lead default b, strike-able): supervising-light
  // unless toggled to the calmer launch-only — one line, s switches.
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
          {/* THE LANES BLOCK yields to the budget (MGR-1): the richest tier
              that fits, clipped inside itself so the prompt below never
              moves; lanes past the budget are counted on the tail line. */}
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
                  {/* THE HARMONY FENCE (T8): the card SHOWS the split so the
                      operator sees the non-overlapping estates — in every
                      tier. */}
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
                  {/* FC-132: end-truncation — the key leads, the chips
                      follow, so the cut can never eat the s the row
                      exists to teach. */}
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
              // The interview never imprisons the screen (tab moves focus
              // under a standing card) — so the card's Select must own no
              // key while focus lives on the board: ↵ on a row used to fire
              // the focused "Yes — start the lanes" instead (MGR-2).
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

// ── the plan's seat-overload ask (T8: still rides past capacity) ────────────

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
  /** REQUIRED focus fact (FC-025): one tab under this card repainted the
   *  screen as the board while the consent kept every key — the next enter,
   *  aimed at a board row, dispatched the lanes. Same law as the plan card
   *  (MGR-2): the prompt owns no key while focus lives elsewhere. */
  focused: boolean
  /** true proceeds (the lanes queue; admission stays the machine's own);
   *  false dispatches NOTHING — the plan card returns, the draft stays. */
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
