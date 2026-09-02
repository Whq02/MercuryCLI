// The composer's imperative helper handles a submission hands its dispatch
// path (cursor reset, buffer clear, history reset). Extracted from the
// retired screen-era submit orchestrator (utils/handlePromptSubmit.ts —
// the steer-removal adjudication: its exported function had NO live call
// site; every importer took only this type) so the three composer surfaces
// keep their contract without carrying dead delivery code beneath it.
export type PromptInputHelpers = {
  setCursorOffset: (offset: number) => void
  clearBuffer: () => void
  resetHistory: () => void
}
