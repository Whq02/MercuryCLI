export const CHOOSE_A_MODEL_ID = 'choose-a-model'
export const CHOOSE_A_MODEL_WORDS = 'choose a model'
export const CHOOSE_A_MODEL_DOOR = `${CHOOSE_A_MODEL_WORDS} · /model`

export function isChooseAModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.trim().toLowerCase() === CHOOSE_A_MODEL_ID
}
