import { getSettingsWithSources } from '../../../platform/settings/settings.js'
import { parseUserSpecifiedModel, getEngineModel, renderModelName } from '../../../models/catalogue/engineModel.js'
import { commandOutputRow } from '../../../engine/rows/project.js'
import { recordTranscript } from '../../../sessions/transcripts/writer.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { setEngineModelOverride } from '../../../boot/process-state/processState.js'
import { setFlagEnv } from '../../../platform/substrate/flagRegistry.js'
import { saveSessionModel } from '../../../sessions/transcripts/sessionStorage.js'
import { isEffortLevel } from '../../../models/effort/effort.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'injectModelSwitchBreadcrumbs' | 'applySeatModel' | 'applySeatEffort'> {
  const { enqueueRow, live, liveScope, messages, setAppState } = ports
  const savedDefaultModel = (): string | null => {
    const stored = getSettingsWithSources().sources.find(source => source.source === 'userSettings')?.settings.engine?.model
    return stored === undefined || stored === '' ? null : parseUserSpecifiedModel(stored)
  }
  const injectModelSwitchBreadcrumbs = async (toModel: string, fromModel: string, words?: string, replacedDefault?: string): Promise<void> => {
    const { createModelSwitchBreadcrumbs, switchClockWords } = await import('../../../engine/message-shapes/factories.js')
    const displayOf = (model: string): string => ports.modelInfos.find(info => info.value === model)?.display_name ?? renderModelName(model)
    const saved = savedDefaultModel() === toModel
    const replaced =
      saved && replacedDefault !== undefined && replacedDefault !== fromModel && replacedDefault !== toModel
        ? { replacedDefaultModel: replacedDefault, replacedDefaultDisplay: displayOf(replacedDefault) }
        : {}
    const breadcrumbs = createModelSwitchBreadcrumbs(words ?? toModel, displayOf(toModel), {
      previousModel: fromModel,
      previousDisplay: displayOf(fromModel),
      savedAsDefault: saved,
      ...replaced,
      model: toModel,
      ...(words === undefined ? {} : { words }),
      at: switchClockWords(new Date()),
    })
    for (const breadcrumb of breadcrumbs) {
      messages.push(breadcrumb)
      const content = breadcrumb.message.content
      if (typeof content === 'string' && content.includes('local-command-stdout')) {
        enqueueRow(commandOutputRow(liveScope(), content, '/model'))
      }
    }
    await recordTranscript(breadcrumbs, undefined, messages).catch((error: unknown) => {
      logForDebugging(`model switch: the /model rows were not recorded — ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const tellSeatEngineSwitch = async (toModel: string): Promise<void> => {
    const { createEngineSwitchNotice } = await import('../../../engine/message-shapes/factories.js')
    const { ledgerClock } = await import('../../../sessions/mneme/ledger.js')
    const display = ports.modelInfos.find(info => info.value === toModel)?.display_name ?? toModel
    const notice = createEngineSwitchNotice(toModel, display, ledgerClock())
    messages.push(notice)
    await recordTranscript([notice], undefined, messages).catch((error: unknown) => {
      logForDebugging(`model switch: the engine notice was not recorded — ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const applySeatModel = async (model: string, words?: string, replacedDefault?: string): Promise<void> => {
    const previous = live.activeModel ?? getEngineModel()
    live.activeModel = model
    setEngineModelOverride(model)
    setFlagEnv('MERCURY_MODEL', model)
    saveSessionModel(model)
    if (model !== previous) {
      await injectModelSwitchBreadcrumbs(model, previous, words, replacedDefault)
      if (getSettingsWithSources().effective.memory?.tellEngineSwitch === true) await tellSeatEngineSwitch(model)
    }
  }
  const applySeatEffort = (effort: string): void => {
    if (!isEffortLevel(effort)) return
    setFlagEnv('MERCURY_EFFORT_LEVEL', effort)
    setAppState(previous => ({ ...previous, effortValue: effort }))
  }
  return { injectModelSwitchBreadcrumbs, applySeatModel, applySeatEffort }
}

export const bindSeatVerbs: BootStep<'injectModelSwitchBreadcrumbs' | 'applySeatModel' | 'applySeatEffort'> = { name: 'bindSeatVerbs', makes: ['injectModelSwitchBreadcrumbs', 'applySeatModel', 'applySeatEffort'], run }
