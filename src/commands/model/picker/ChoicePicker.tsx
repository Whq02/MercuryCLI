import * as React from 'react'
import { MercuryModelPicker, type ModelChoice } from './MercuryModelPicker.js'
import { getSdkBetas } from '../../../boot/process-state/processState.js'
import { getModelOptions, isCatalogueDoorRow, isProviderActionRow } from '../../../models/catalogue/modelOptions.js'
import { useCatalogueEpoch } from '../../../screen/model-picker/useCatalogueEpoch.js'
import { GPT_ROAD, OPENROUTER_ROAD, GEMINI_ROAD, ANTHROPIC_SUBSCRIPTION_ROAD, ANTHROPIC_KEY_ROAD, ANTHROPIC_BEARER_ROAD, NOUS_ROAD, HUGGINGFACE_ROAD, MOONSHOT_ROAD, DEEPSEEK_ROAD, ZAI_ROAD, XAI_ROAD, META_ROAD, MINIMAX_ROAD, TOGETHER_ROAD, COHERE_ROAD, GROQ_ROAD, MELIOUS_ROAD, CEREBRAS_ROAD, FIREWORKS_ROAD, QWEN_ROAD, MISTRAL_ROAD, LOCAL_ROAD, useCatalogueRefreshOnOpen } from './roads.js'
import { providerHeadingsOf } from './headings.js'
import { modelChoiceOf, expandRowsOf, seatGroupOf, orderedModelChoices, retryNamedCompatRow } from './rows.js'

export function MercuryModelChoicePicker({ leading, current, onSelect, onSignIn, onClose, line, hint, ctxPct = null }: {
  leading?: ModelChoice[]
  current: string
  onSelect: (id: string) => void
  onSignIn?: (id: string) => void
  onClose: () => void
  line?: string
  hint?: string
  ctxPct?: number | null
}): React.ReactNode {
  useCatalogueEpoch()
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
  const betas = getSdkBetas()
  const options = getModelOptions().filter(opt => onSignIn !== undefined || !isProviderActionRow(opt.value) || isCatalogueDoorRow(opt.value))
  const catalogue = options.map(opt => modelChoiceOf(opt, betas))
  const models: ModelChoice[] = [...(leading ?? []), ...orderedModelChoices(catalogue, current)]
  const topGroup = seatGroupOf(models, current)
  return (
    <MercuryModelPicker
      models={models}
      current={current}
      ctxPct={ctxPct}
      notice={notice ?? line}
      headings={providerHeadingsOf(0)}
      {...(topGroup !== undefined ? { topGroup } : {})}
      {...(hint !== undefined ? { hint } : {})}
      expandRows={group => expandRowsOf(group, betas)}
      onSelect={id => {
        if (isCatalogueDoorRow(id)) return
        if (isProviderActionRow(id)) {
          if (!retryNamedCompatRow(id, setNotice)) onSignIn?.(id)
          return
        }
        onSelect(id)
      }}
      onClose={onClose}
    />
  )
}
