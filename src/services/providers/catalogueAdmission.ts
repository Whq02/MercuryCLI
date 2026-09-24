export function modelNotOfferedByCatalogue(modelId: string, accountLabel: string, offered: readonly string[], servedAs: readonly string[] = []): string {
  const hint = offered.length > 0 ? ` The catalogue offers: ${offered.join(', ')}.` : ''
  const alias = servedAs.length > 0 ? ` ${modelId} is served here as ${servedAs.join(', ')}.` : ''
  return `model '${modelId}' is not offered by the ${accountLabel} live catalogue.${alias}${hint}`
}
