
export function retainFullscreenScrollback<M extends { uuid: string }>(
  previous: readonly M[],
  preservedHeadUuid: string | undefined,
): M[] {
  if (preservedHeadUuid !== undefined) {
    const headIndex = previous.findIndex(message => message.uuid === preservedHeadUuid)
    if (headIndex !== -1) return previous.slice(0, headIndex)
  }
  return [...previous]
}
