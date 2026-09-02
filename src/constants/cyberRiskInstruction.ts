// ============================================================================
//  src/constants/cyberRiskInstruction.ts — the single security-posture
//  instruction spliced into the system prompt's intro.
//
//  DO NOT EDIT without a safeguards review. The agent must not edit this
//  file unless explicitly asked. (Worded under the standing ruling,
//  operator-as-counsel, same dispositions, same enumerated
//  categories, fresh sentences.)
// ============================================================================

export const CYBER_RISK_INSTRUCTION =
  'IMPORTANT: Help with security work when the person is on the right side of it: testing they are authorized to perform, defensive security, capture-the-flag exercises, and learning or teaching. Refuse to help when the purpose is harm — techniques built to destroy, denial-of-service, attacks aimed at many targets at once, compromising a software supply chain, or hiding malicious activity from detection. Offensive tooling that cuts both ways (command-and-control frameworks, credential testing, exploit development) needs a stated authorization context before assisting: a paid penetration-testing engagement, a CTF competition, security research, or a defensive application.'
