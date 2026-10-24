import type { LlmHostRoad } from '../llmHost/index.js'
import { shortFolder } from './bank.js'
import { currentPrivateHostRecipes, privateHostRecipesCandidates, rememberPrivateHostRecipesFile, validatePrivateHostRecipesPath, type PrivateHostRecipes } from './recipesFile.js'

export const PRIVATE_RECIPES_ROW = 'private-recipes'
const PRIVATE_RECIPES_EMPTY = 'Private recipes · none · choose a file →'
const PRIVATE_RECIPES_REPLACES = 'replaces the shipped list'
const PRIVATE_RECIPES_PROMPT = 'Which private recipes file?'
export function privateRecipesRow(state = currentPrivateHostRecipes()): { value: string; label: string } {
  const loaded = state.path && state.recipes.length
  return { value: PRIVATE_RECIPES_ROW, label: loaded ? 'Private recipes · ' + shortFolder(state.path!) + ' · ' + state.recipes.length + ' rows · ' + PRIVATE_RECIPES_REPLACES : PRIVATE_RECIPES_EMPTY }
}

const summary = (state: PrivateHostRecipes): string => (state.path ? shortFolder(state.path) + ' · ' : '') + state.recipes.length + ' rows\n' + [...new Set(state.recipes.map(row => row.label.split(' · ')[0]! + ' · ' + row.model))].join('\n')

export async function choosePrivateRecipesFile(ask: Parameters<LlmHostRoad>[0], signal: AbortSignal): Promise<string | undefined> {
  const current = currentPrivateHostRecipes()
  let initial = shortFolder(current.path ?? privateHostRecipesCandidates()[0]!)
  let error = current.errors.join('\n')
  while (!signal.aborted) {
    const named = await ask({ step: 'door-private-recipes-file', title: PRIVATE_RECIPES_PROMPT, found: [error, current.recipes.length ? 'Loaded: ' + summary(current) : 'No private recipes loaded.', 'Candidates:\n' + privateHostRecipesCandidates().map(shortFolder).join('\n')].filter(Boolean).join('\n'), willRun: 'Enter an absolute file path. The file replaces the shipped list. Checked before saving; nothing runs.', initial })
    if (named === null || signal.aborted) return
    initial = named
    try {
      const inspected = validatePrivateHostRecipesPath(named)
      const choice = await ask({ step: 'door-private-recipes-confirm', title: 'Use this private recipes file?', found: summary(inspected), willRun: 'This file replaces the shipped list. Only use recipes you trust: they can contain install commands. Nothing runs now.', rows: [{ value: 'use', label: 'Use this file' }, { value: 'change', label: 'Change file' }] })
      if (choice === null || signal.aborted) return
      if (choice !== 'use') { error = ''; continue }
      const saved = rememberPrivateHostRecipesFile(inspected.path)
      return 'Private recipes loaded · ' + saved.recipes.length + ' rows · ' + shortFolder(saved.path)
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
  }
}
