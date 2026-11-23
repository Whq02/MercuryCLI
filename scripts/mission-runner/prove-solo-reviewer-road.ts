import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { policyById } from './live/policies.ts'
import { VERIFIER_BRIEF } from '../../src/commands/verify/index.ts'

const policy = policyById('solo-reviewer')
const suffix = policy.briefSuffix ?? ''
assert.ok(suffix.includes(VERIFIER_BRIEF), 'solo reviewer carries the command-owned verification brief: the solo-reviewer policy briefSuffix in scripts/mission-runner/live/policies.ts must embed VERIFIER_BRIEF from src/commands/verify/index.ts')
assert.match(suffix, /Crewmate tool/, 'independent review runs through the Crewmate tool: the solo-reviewer briefSuffix in scripts/mission-runner/live/policies.ts must name the Crewmate tool')
assert.doesNotMatch(suffix, /\bSkill\b|\bskill\b/, 'no policy routes to a skill: remove the word skill from the solo-reviewer briefSuffix in scripts/mission-runner/live/policies.ts (VERIFIER_BRIEF in src/commands/verify/index.ts is part of it)')
assert.match(suffix, /REVIEW: accept\|revise\|reject/, 'the mission verdict tail remains: the solo-reviewer briefSuffix in scripts/mission-runner/live/policies.ts must end with the REVIEW: accept|revise|reject line')
const runner = readFileSync(new URL('./live/runner.ts', import.meta.url), 'utf8')
assert.ok(runner.includes("(policy.briefPrefix ?? '') + task.brief + (policy.briefSuffix ?? '')"), 'the runner dispatches the tested policy suffix: runTaskWithPolicy in scripts/mission-runner/live/runner.ts must build the brief as briefPrefix + task.brief + briefSuffix')
console.log('SOLO REVIEWER ROAD GREEN')
