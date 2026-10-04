import { getModelUsage, getUnpricedTurns, getWorkloadUnpricedTurns, getWorkloadUsage, type ModelUsage } from '../../bootstrap/state.js'
import type { ModelSpendRowV1 } from './types.js'

export function modelSpendRowsOf(
  usage: { [modelName: string]: ModelUsage },
  unpriced: { [modelName: string]: number },
  workload?: string,
): ModelSpendRowV1[] {
  const rows: ModelSpendRowV1[] = []
  const tag = workload === undefined ? {} : { workload }
  for (const [model, record] of Object.entries(usage)) {
    rows.push({
      model,
      ...tag,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadInputTokens: record.cacheReadInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      costUSD: record.costUSD,
      unpricedTurns: unpriced[model] ?? 0,
    })
  }
  for (const [model, turns] of Object.entries(unpriced)) {
    if (turns > 0 && usage[model] === undefined) {
      rows.push({ model, ...tag, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, unpricedTurns: turns })
    }
  }
  return rows
}

export function sessionModelSpendRows(): ModelSpendRowV1[] {
  const rows = modelSpendRowsOf(getModelUsage(), getUnpricedTurns())
  const usage = getWorkloadUsage()
  const unpriced = getWorkloadUnpricedTurns()
  for (const workload of new Set([...Object.keys(usage), ...Object.keys(unpriced)])) {
    rows.push(...modelSpendRowsOf(usage[workload] ?? {}, unpriced[workload] ?? {}, workload))
  }
  return rows
}
