import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { TransitionPreviewCard } from '../../components/TransitionPreviewCard.js'
import { useAppState, useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { handleScribeRouterSelect } from '../../utils/scribe/scribeRouterSelect.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { usabilityForRoute } from '../../services/providers/providerUsability.js'
import {
  previewForSelection,
  reconfirmTransitionPlan,
  transitionPlanSummary,
} from '../../services/providers/transitionPreview.js'
import {
  crossProviderNote,
  providerFamilyOfSetting,
  settleModelSelection,
  type SettledSelection,
  type TransitionPlan,
} from '../../utils/model/modelTransition.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from '../../utils/model/check1mAccess.js'
import {
  getDefaultMainLoopModel,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
  renderDefaultModelLabel,
  renderDefaultModelSetting,
  renderModelName,
  type ModelSetting,
} from '../../utils/model/model.js'
import { resolveEffortTruth, type EffortValue } from '../../utils/effort.js'
import { errorMessage } from '../../utils/errors.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { ModelSwitchReceiptV1 } from '../../services/engine-connector/types.js'

/** The shared renderer; null renders the computed default's row with the
 *  default marker, its provider and the sign-in it came from (or the
 *  logins door when no sign-in exists). */
function renderModelLabel(setting: ModelSetting): string {
  if (setting === null) return renderDefaultModelLabel()
  return renderDefaultModelSetting(setting)
}

/** The effort parenthetical (empty when no effort value is set). */
function effortParenthetical(
  base: ModelSetting,
  override: ModelSetting,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const requested = String(effortValue)
  const liveSetting = override ?? base
  const normalised =
    liveSetting === null ? getDefaultMainLoopModel() : parseUserSpecifiedModel(liveSetting)
  // When normalisation yields nothing, no "runs at" clause is produced.
  // Otherwise the clause is the one effort owner's: a model with no effort
  // control says the value is not sent; a wire that omits the key says the
  // provider default applies; a stepped value names the tier it runs at —
  // the bare "(effort: max)" claimed the request as the applied value.
  if (normalised) {
    const truth = resolveEffortTruth(normalised, effortValue)
    if (!truth.supportsEffort) {
      return ` (effort: ${requested} — not sent; ${renderModelName(normalised)} takes no effort setting)`
    }
    if (truth.wire === undefined) {
      return ` (effort: ${requested} — not sent; the provider default applies)`
    }
    if (truth.label !== requested) {
      return ` (effort: ${requested} — runs at ${truth.label})`
    }
  }
  return ` (effort: ${requested})`
}

/** The focused chat's answer to a model switch, in the operator's words. */
function focusedSwitchSentence(receipt: ModelSwitchReceiptV1, target: ModelSetting): string {
  const label = renderModelLabel(target)
  switch (receipt.state) {
    case 'applied':
      return `Model set to ${label} — this session's next message runs it`
    case 'queued':
      return `Model switch queued: ${label} takes effect when this session's turn settles — the running turn keeps its model`
    case 'no-op':
      return `Already on ${label} — nothing to change.`
    default:
      return `The model switch was refused: ${receipt.detail}`
  }
}

/** The current-model readout. Renders nothing. */
function ModelReadout({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const base = useAppState(state => state.mainLoopModel)
  const override = useAppState(state => state.mainLoopModelForSession)
  const effortValue = useAppState(state => state.effortValue)
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    // A daemon-hosted focused chat answers from ITS OWN model facts — never
    // the in-process engine's.
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const facts = focused.modelFacts()
      const pending = facts.pendingSwitch ? ` (switching to ${renderModelLabel(facts.pendingSwitch.setting)} when this turn ends)` : ''
      onDone(`Current model: ${renderModelLabel(facts.effective)}${pending}`)
      return
    }
    const parenthetical = effortParenthetical(base, override, effortValue)
    if (override !== null) {
      onDone(
        [
          `Current model: ${renderModelLabel(override)} (session override from strategy mode)`,
          `Base model: ${renderModelLabel(base)}${parenthetical}`,
        ].join('\n'),
      )
      return
    }
    onDone(`Current model: ${renderModelLabel(base)}${parenthetical}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

/**
 * The set path. Validates once per mount, probes the settlement
 * owner, parks on the preview card when the plan needs a choice, and applies
 * only through `settleModelSelection` — never a direct state write.
 */
function ModelSet({
  target,
  raw,
  messages,
  onDone,
}: {
  /** `null` = clear the explicit model (the literal argument `default`). */
  target: ModelSetting
  /** The argument exactly as typed (validation is case-sensitive). */
  raw: string
  messages: Message[]
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const base = useAppState(state => state.mainLoopModel)
  const override = useAppState(state => state.mainLoopModelForSession)
  const pendingSwitch = useAppState(state => state.pendingModelSwitch)
  const turnRunning = useAppState(state => state.foregroundTurnActive)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const [held, setHeld] = useState<{ plan: TransitionPlan; refreshed: boolean } | null>(null)
  const ranRef = useRef(false)

  const settlementMessage = (
    landed: SettledSelection,
    plan: TransitionPlan | null,
  ): string => {
    const label = renderModelLabel(target)
    if (landed.kind === 'no-op') {
      return `Already on ${label} — nothing to change.`
    }
    if (landed.kind === 'cancelled-pending') {
      return `Already on ${label} — cancelled the previously queued model switch.`
    }
    const lossNote = plan ? transitionPlanSummary(plan) : ''
    if (landed.kind === 'queued') {
      const cross = landed.crossProvider ? crossProviderNote(target) : ''
      return `Model switch queued: ${label} takes effect when the current turn settles — the running turn keeps its model.${cross}${lossNote}`
    }
    // applied — suffixes in the documented order.
    const cross = landed.receipt.crossProvider ? crossProviderNote(target) : ''
    return `Model set to ${label}${cross}${lossNote}`
  }

  /** Every apply rides the ONE settlement owner — the focused chat's: a
   *  daemon-hosted session switches through its connector's model door
   *  (its own settlement owner applies now or parks for the turn's end);
   *  the in-process engine through settleModelSelection. */
  const applyNow = async (plan: TransitionPlan | null): Promise<void> => {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      // The cross-provider fact reads the session's effective model BEFORE
      // the door applies the switch (an applied receipt updates the
      // connector's facts synchronously — a post-apply read would compare
      // the destination against itself and stay silent, which is exactly
      // how the note never reached this branch — FN-016 R17).
      const factsBefore = focused.modelFacts()
      // The receipt is the daemon's word (FN-015 rank 50): the sentence
      // waits for it, so a refusal is spoken and never painted as a switch.
      const receipt = await focused.setModel(target)
      const moved = receipt.state === 'applied' || receipt.state === 'queued'
      const doorCross =
        moved && providerFamilyOfSetting(factsBefore.effective) !== providerFamilyOfSetting(target)
          ? crossProviderNote(target)
          : ''
      const lossNote = plan && receipt.state !== 'no-op' && receipt.state !== 'refused' ? transitionPlanSummary(plan) : ''
      onDone(`${focusedSwitchSentence(receipt, target)}${doorCross}${lossNote}`)
      return
    }
    // Mode exit parity for the TYPED path: the pickers treat a REAL model
    // pick while the scribe router is engaged as the exit — `/model <arg>`
    // would otherwise switch the wire model UNDER the engaged mode, leaving
    // persona pack, hooks and team identity running against a model the
    // mode never chose (the "seat not applied" leak). Same shared handler,
    // same order: exit first, then apply — the operator's typed choice wins
    // over the exit's restore. Runs only here (after validation and the
    // needs-choice gate), so an invalid model or a cancelled preview never
    // half-exits a mode.
    const routerOutcome = handleScribeRouterSelect(target, { setAppState, store })
    const left = routerOutcome === 'disengaged' ? ' · left Scribe Mode' : ''
    // The initializer is CAST to the union (the REPL boundary effect's
    // idiom): a plain literal initializer narrows `landed` to its no-op
    // member — the updater-closure assignment is invisible to CFA — and the
    // kind checks below then collapse the type to never (the TS2339 class).
    let landed = {
      kind: 'no-op',
      patch: null,
      receipt: null,
    } as SettledSelection
    setAppState(prev => {
      landed = settleModelSelection(prev, target, {
        turnActive: prev.foregroundTurnActive || prev.pendingModelSwitch !== null,
      })
      return landed.patch ? { ...prev, ...landed.patch } : prev
    })
    if ((landed.kind === 'no-op' || landed.kind === 'cancelled-pending') && left) {
      // Mode exit re-applies the underlying model even when it equals the
      // exit's restored one — bookkeeping, not a transition (the pickers'
      // shared rule; no receipt row for an identity that did not change).
      setAppState(prev => ({
        ...prev,
        mainLoopModel: target,
        mainLoopModelForSession: null,
        pendingModelSwitch: null,
      }))
      onDone(`Model set to ${renderModelLabel(target)}${left}`)
      return
    }
    onDone(`${settlementMessage(landed, plan)}${left}`)
  }

  useEffect(() => {
    // Once per mount (the run-once rule) — never re-run on a host
    // re-render while parked.
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      // 1. Organisation allowlist.
      if (target !== null && !isModelAllowed(target)) {
        onDone(
          `${raw} isn't available: your organization restricts model selection.`,
          { display: 'system' },
        )
        return
      }
      const lowered = raw.trim().toLowerCase()
      if (target !== null) {
        // 2. 1M-context Opus availability (the merge capability is an
        //    escape hatch HERE and only here).
        if (
          lowered.includes('opus') &&
          lowered.includes('[1m]') &&
          !checkOpus1mAccess() &&
          !isOpus1mMergeEnabled()
        ) {
          onDone(
            `The 1M-context ${renderModelName(target)} model isn't available for this account. Run /model to pick a different model.`,
            { display: 'system' },
          )
          return
        }
        // 3. 1M-context Sonnet availability — same message shape,
        // deliberately narrower condition.
        if (
          (lowered.includes('sonnet[1m]') || lowered.includes('sonnet-4-6[1m]')) &&
          !checkSonnet1mAccess()
        ) {
          onDone(
            `The 1M-context ${renderModelName(target)} model isn't available for this account. Run /model to pick a different model.`,
            { display: 'system' },
          )
          return
        }
        // 5. Known aliases skip validation (compared lowercased+trimmed);
        // 6. everything else validates, case-sensitively.
        if (!isModelAlias(lowered)) {
          try {
            const verdict = await validateModel(raw)
            if (!verdict.valid) {
              onDone(verdict.error ?? `Model ${raw} not found.`, { display: 'system' })
              return
            }
          } catch (thrown) {
            onDone(`Model validation failed: ${errorMessage(thrown)}`, {
              display: 'system',
            })
            return
          }
        }
      }
      // A DAEMON-hosted session's gate is computed from the session it
      // gates (FN-013 MODEL-02): the plan's `from` and messages come from
      // the EXECUTING session's connector — its model facts and its
      // records — never from this screen's AppState, which can hold a
      // different model and a different history than the session the
      // switch is applied to (the gate could pass a lossy switch or warn
      // about a transition between two models the session is on neither
      // of). When the session's own facts cannot be read (no live facts,
      // no admission record — the connector would fall back to this
      // process's ambient state), the pick REFUSES typed, naming what
      // could not be resolved; no plan is built and no model is written.
      const focusedForPlan = getFocusedSessionConnector()
      if (focusedForPlan.carrier === 'daemon') {
        const sessionFacts = focusedForPlan.modelFacts()
        if (sessionFacts.effectiveSource === 'ambient') {
          onDone(
            "The model switch was refused: the session's own model facts could not be resolved (no live facts and no recorded model on its admission record) — the preview will not be built from another session's state. Retry once the session reports its facts.",
            { display: 'system' },
          )
          return
        }
        const sessionMessages = [...focusedForPlan.records()]
        const plan = previewForSelection(sessionMessages, sessionFacts.effective, target)
        if (plan.needsChoice) {
          setHeld({ plan, refreshed: false })
          return
        }
        void applyNow(plan)
        return
      }
      // Probe the settlement owner — probing writes nothing.
      const probe = settleModelSelection(
        {
          mainLoopModel: base,
          mainLoopModelForSession: override,
          pendingModelSwitch: pendingSwitch,
        },
        target,
        {
          turnActive: turnRunning || pendingSwitch !== null,
        },
      )
      if (probe.kind === 'queued' || probe.kind === 'applied') {
        const plan = previewForSelection(messages, override ?? base, target)
        if (plan.needsChoice) {
          setHeld({ plan, refreshed: false })
          return
        }
        void applyNow(plan)
        return
      }
      // no-op / cancelled-pending: the loss note is never computed.
      void applyNow(null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (held) {
    // The from-label: a daemon carrier's card names the EXECUTING
    // session's own model (the plan's from — FN-013 MODEL-02); the
    // in-process card keeps reading the live effective model.
    const heldIsDaemon = getFocusedSessionConnector().carrier === 'daemon'
    const effective = override ?? base
    return (
      <TransitionPreviewCard
        plan={held.plan}
        fromLabel={renderModelLabel(heldIsDaemon ? held.plan.from : effective)}
        toLabel={renderModelLabel(target)}
        refreshed={held.refreshed}
        targetUsability={usabilityForRoute(held.plan.targetRoute)}
        onConfirm={() => {
          // Confirm re-derives the plan; a drifted plan re-presents and
          // writes NOTHING. The re-derivation reads the SAME source the
          // plan was built from — the executing session's records for a
          // daemon carrier, the screen's messages in-process.
          const confirmMessages =
            getFocusedSessionConnector().carrier === 'daemon'
              ? [...getFocusedSessionConnector().records()]
              : messages
          const verdict = reconfirmTransitionPlan(held.plan, confirmMessages)
          if (!verdict.ok) {
            setHeld({ plan: verdict.freshPlan, refreshed: true })
            return
          }
          setHeld(null)
          void applyNow(held.plan)
        }}
        onCancel={() => {
          setHeld(null)
          onDone(
            `Kept ${renderModelLabel(effective)} — the model switch was cancelled at the preview.`,
          )
        }}
      />
    )
  }
  return null
}

/**
 * Dispatch. The empty-argument picker branch is NOT built: the
 * Mercury `/model` command never delegates an empty argument here.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode | undefined> {
  const trimmed = (args ?? '').trim()
  if (!trimmed) return undefined
  const lowered = trimmed.toLowerCase()
  if (COMMON_INFO_ARGS.includes(lowered)) {
    return <ModelReadout onDone={onDone} />
  }
  if (COMMON_HELP_ARGS.includes(lowered)) {
    onDone(
      'Run /model with no argument to open the model selection menu, or /model <modelName> to set the model directly.',
      { display: 'system' },
    )
    return undefined
  }
  return (
    <ModelSet
      target={trimmed === 'default' ? null : trimmed}
      raw={trimmed}
      messages={context.messages ?? []}
      onDone={onDone}
    />
  )
}
