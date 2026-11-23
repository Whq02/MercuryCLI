import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getEngineModel, getUserSpecifiedModelSetting, parseUserSpecifiedModel, renderModelChip } from '../../../../models/catalogue/engineModel.js'
import { describeFrontierDecision, frontierOperatorDecision } from '../../../../models/catalogue/frontierPolicy.js'
import { CHOOSE_A_MODEL_WORDS, computedDefault, describeComputedDefault, isChooseAModel } from '../../../../models/catalogue/computedDefault.js'
import { providerDisplayName } from '../../../../models/roads/routeLaw.js'
import { getSettingsWithAllErrors } from '../../../settings-faults/allErrors.js'
import { recognizeModelId, unrecognisedModelIdReason } from '../../../../models/roads/idSpaces.js'
import { unresolvedDefaultRow, type CheckSpec } from '../../healthReport.js'
import { passedOver } from '../../../errors/passedOver.js'

export function modelCheck(): CheckSpec {
  return {
    id: 'model',
    label: 'Model pins',
    run: () => {
      const session = getEngineModel()
      const pin = getSettingsWithAllErrors().settings.engine?.model
      if (!isChooseAModel(session) && recognizeModelId(session).kind === 'unrecognised') {
        return {
          status: 'warn',
          evidence: `session model ${session}${pin && pin !== session ? ` · settings pin ${pin}` : ''} — ${unrecognisedModelIdReason(session)}`,
          fix: 'No connected provider family declares this model id. Pick a model from /model, or route it through a custom endpoint that knows the id.',
        }
      }
      if (!pin) {
        return { status: 'ok', evidence: `session model ${unresolvedDefaultRow() ?? (isChooseAModel(session) ? CHOOSE_A_MODEL_WORDS : session)} · no settings pin` }
      }
      let pinResolved = pin
      try {
        pinResolved = parseUserSpecifiedModel(pin)
      } catch (error) {
        passedOver(error)
      }
      if (pinResolved === session) {
        return {
          status: 'ok',
          evidence:
            pin === session
              ? `session model ${session} = settings pin`
              : `session model ${session} = settings pin '${pin}' (resolved)`,
        }
      }
      return {
        status: 'info',
        evidence: `session model ${session} · settings pin ${pin}${pinResolved !== pin ? ` (resolves to ${pinResolved})` : ''} — the live session overrides the pin`,
        detail:
          'The settings pin is not the live session model — crewmates inherit the session. Pass model: explicitly where drift matters.',
      }
    },
  }
}

export function frontierCheck(): CheckSpec {
  return {
    id: 'frontier',
    label: 'Default model',
    run: () => {
      const decision = computedDefault()
      const firstParty = frontierOperatorDecision()
      const order = firstParty.candidates
        .map(c => `${c.family}@${c.rank} ${c.eligible ? 'eligible' : c.code}`)
        .join(' · ')
      const computed =
        decision.source === 'keyless'
          ? describeComputedDefault(decision, providerDisplayName)
          : `fresh-session default ${renderModelChip(decision.setting)} · ${describeComputedDefault(decision, providerDisplayName)}`
      const pinned = getUserSpecifiedModelSetting()
      const { disabledProvidersHealthSummary } = require('../../../../models/roads/disabledProviders.js') as typeof import('../../../../models/roads/disabledProviders.js')
      const disabledNote = disabledProvidersHealthSummary()?.evidence
      const suffix = disabledNote ? ` · ${disabledNote}` : ''
      if (pinned !== null) {
        let resolved = pinned
        try {
          resolved = parseUserSpecifiedModel(pinned)
        } catch {
          resolved = pinned
        }
        const { getEngineModelOverride } = require('../../../../boot/process-state/processState.js') as typeof import('../../../../boot/process-state/processState.js')
        const pinSource = getEngineModelOverride() !== undefined ? 'the --model flag' : flagEnv('MERCURY_MODEL') ? 'MERCURY_MODEL' : 'the settings pin engine.model'
        return {
          status: 'info' as const,
          evidence: `fresh-session default ${renderModelChip(resolved)} · ${pinSource}${resolved !== pinned ? ` '${pinned}' (resolved)` : ''} — without the pin: ${computed.replace(/^fresh-session default /, '')}${suffix}`,
          detail: `first-party gating: ${describeFrontierDecision(firstParty)} — candidates: ${order}`,
          link: '/model',
        }
      }
      return {
        status: 'info' as const,
        evidence: `${computed}${suffix}`,
        detail: `first-party gating: ${describeFrontierDecision(firstParty)} — candidates: ${order}`,
        link: '/model',
      }
    },
  }
}
