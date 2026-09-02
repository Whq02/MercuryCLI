/**
 * The child views' projection vocabulary (MERCURY INTERVIEW Wave B).
 *
 * Durable interview meaning lives in the ONE session authority
 * (src/services/interview/store.ts); the request component projects it into
 * this per-question display shape for the views. The historical
 * useMultipleChoiceState reducer that once OWNED this state is retired —
 * the type is the only survivor.
 */

export type QuestionState = {
  selectedValue?: string | string[]
  textInputValue: string
}
