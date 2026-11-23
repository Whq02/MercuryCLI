import * as React from 'react'
import { MercuryModelPicker, type ModelChoice } from './MercuryModelPicker.js'
import { getSdkBetas } from '../../../boot/process-state/processState.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { getModelOptions, isCatalogueDoorRow, isProviderActionRow, signInFamilyOfRow } from '../../../models/catalogue/modelOptions.js'
import { nextBirthModel } from '../../../daemon/switchboard/bootBirthFacts.js'
import { modelSupportsEffort, selectableEffortLevels } from '../../../models/effort/effort.js'
import { useCatalogueEpoch } from '../../../screen/model-picker/useCatalogueEpoch.js'
import { GPT_ROAD, OPENROUTER_ROAD, GEMINI_ROAD, ANTHROPIC_SUBSCRIPTION_ROAD, ANTHROPIC_KEY_ROAD, ANTHROPIC_BEARER_ROAD, NOUS_ROAD, HUGGINGFACE_ROAD, MOONSHOT_ROAD, DEEPSEEK_ROAD, ZAI_ROAD, XAI_ROAD, META_ROAD, MINIMAX_ROAD, TOGETHER_ROAD, COHERE_ROAD, GROQ_ROAD, MELIOUS_ROAD, CEREBRAS_ROAD, FIREWORKS_ROAD, QWEN_ROAD, MISTRAL_ROAD, LOCAL_ROAD, useCatalogueRefreshOnOpen } from './roads.js'
import { providerHeadingsOf } from './headings.js'
import { resolveCurrentRowId, modelChoiceOf, expandRowsOf, seatGroupOf, orderedModelChoices, noteModelUse, retryNamedCompatRow } from './rows.js'

export function MercurySessionModelPicker({
  currentModel,
  currentEffort,
  onSelect,
  onEffort,
  onDone,
  onSignIn,
}: {
  currentModel: string | undefined
  currentEffort: string | undefined
  onSelect: (modelId: string, displayName: string) => void
  onEffort: (effort: string) => void
  onDone: () => void
  onSignIn?: (family: string | undefined) => void
}): React.ReactNode {
  useCatalogueEpoch()
  const betas = getSdkBetas()
  const model = currentModel ?? nextBirthModel() ?? getEngineModel()
  const efforts = modelSupportsEffort(model) ? [...selectableEffortLevels(model)] : []
  const effort = currentEffort ?? 'default'
  const [slotVersion] = React.useState(0)
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  useCatalogueRefreshOnOpen(GPT_ROAD, setNotice)
  useCatalogueRefreshOnOpen(OPENROUTER_ROAD, setNotice)
  useCatalogueRefreshOnOpen(GEMINI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(HUGGINGFACE_ROAD, setNotice)
  useCatalogueRefreshOnOpen(NOUS_ROAD, setNotice)
  useCatalogueRefreshOnOpen(MOONSHOT_ROAD, setNotice)
  useCatalogueRefreshOnOpen(DEEPSEEK_ROAD, setNotice)
  useCatalogueRefreshOnOpen(ZAI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(XAI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(META_ROAD, setNotice)
  useCatalogueRefreshOnOpen(MISTRAL_ROAD, setNotice)
  useCatalogueRefreshOnOpen(MINIMAX_ROAD, setNotice)
  useCatalogueRefreshOnOpen(TOGETHER_ROAD, setNotice)
  useCatalogueRefreshOnOpen(COHERE_ROAD, setNotice)
  useCatalogueRefreshOnOpen(GROQ_ROAD, setNotice)
  useCatalogueRefreshOnOpen(MELIOUS_ROAD, setNotice)
  useCatalogueRefreshOnOpen(CEREBRAS_ROAD, setNotice)
  useCatalogueRefreshOnOpen(FIREWORKS_ROAD, setNotice)
  useCatalogueRefreshOnOpen(QWEN_ROAD, setNotice)
  useCatalogueRefreshOnOpen(LOCAL_ROAD, setNotice)
  useCatalogueRefreshOnOpen(ANTHROPIC_SUBSCRIPTION_ROAD, setNotice)
  useCatalogueRefreshOnOpen(ANTHROPIC_KEY_ROAD, setNotice)
  useCatalogueRefreshOnOpen(ANTHROPIC_BEARER_ROAD, setNotice)
  const options = getModelOptions()
  const listedModels: ModelChoice[] = options.map(opt => modelChoiceOf(opt, betas))
  const currentRowId = resolveCurrentRowId(listedModels, model)
  const models = orderedModelChoices(listedModels, currentRowId)
  const topGroup = seatGroupOf(listedModels, currentRowId)
  function handleEffort(mode: string): void {
    onEffort(mode)
  }
  function handleSelect(id: string, door?: string): void {
    if (isCatalogueDoorRow(id)) return
    if (isProviderActionRow(id)) {
      if (!retryNamedCompatRow(id, setNotice)) onSignIn?.(signInFamilyOfRow(id))
      return
    }
    noteModelUse(id, door)
    onSelect(id, models.find(m => m.id === id)?.name ?? id)
    onDone()
  }
  return (
    <MercuryModelPicker
      models={models}
      current={currentRowId}
      ctxPct={null}
      efforts={efforts}
      effort={effort}
      onEffort={handleEffort}
      notice={notice}
      headings={providerHeadingsOf(slotVersion)}
      {...(topGroup !== undefined ? { topGroup } : {})}
      expandRows={group => expandRowsOf(group, betas)}
      onSelect={handleSelect}
      onClose={onDone}
    />
  )
}
