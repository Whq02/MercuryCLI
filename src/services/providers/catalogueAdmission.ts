export function modelNotOfferedByCatalogue(modelId: string, accountLabel: string, offered: readonly string[]): string {
  const hint = offered.length > 0 ? ` The catalogue offers: ${offered.join(', ')}.` : ''
  return `model '${modelId}' is not offered by the ${accountLabel} live catalogue.${hint}`
}
