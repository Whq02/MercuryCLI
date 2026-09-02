/**
 * Skill self-improvement side channel.
 *
 * The detection/apply machinery is not built (operator drop-dead-machinery
 * ruling): the initialiser was already empty in the snapshot,
 * so the post-sampling hook was never registered and the apply path had
 * zero callers. Only the live no-op initialiser survives for its caller in
 * the background-housekeeping scheduler.
 */

export type SkillUpdate = {
  section: string
  change: string
  userMessage: string
}

export function initSkillImprovement(): void {}
