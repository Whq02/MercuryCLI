/**
 * Attribution-suppression mode (inert in this build).
 *
 * Documented intent, kept for a future re-enablement: when active, the
 * product adds safety instructions to commit and pull-request prompts and
 * strips all attribution so pre-release model codenames cannot leak, and
 * the model is not told which model it is. A re-enablement would register
 * a MERCURY force-on with deliberately NO force-off, because the failure
 * mode being guarded against is a codename leak. In this build every entry
 * point returns its constant.
 */

export function isUndercover(): boolean {
  return false
}

export function getUndercoverInstructions(): string {
  return ''
}
