/**
 * The analytics posture gate. Both predicates are unconditionally true in
 * this product — under every environment and every build stamp. The vendor
 * transports they gated are structurally deleted, so these document the
 * posture and stand as defence in depth. A customer's own OpenTelemetry
 * export (their own OTEL_* exporter configuration to their own endpoint) is
 * a separate path and remains intact.
 */

export function isAnalyticsDisabled(): boolean {
  return true
}

/**
 * Distinct from the analytics posture: the survey is a purely local UI
 * prompt with no transcript data, so it deliberately does not gate on
 * third-party providers — and it is off all the same.
 */
export function isFeedbackSurveyDisabled(): boolean {
  return true
}
