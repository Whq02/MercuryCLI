import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { policyById } from './live/policies.ts'
import { VERIFIER_BRIEF } from '../../src/commands/verify.ts'

const policy = policyById('solo-reviewer')
const suffix = policy.briefSuffix ?? ''
assert.ok(suffix.includes(VERIFIER_BRIEF), 'solo reviewer carries the command-owned verification brief')
assert.match(suffix, /Crewmate tool/, 'independent review runs through the Crewmate tool')
assert.doesNotMatch(suffix, /\bSkill\b|\bskill\b/, 'no policy routes to a skill')
assert.match(suffix, /REVIEW: accept\|revise\|reject/, 'the mission verdict tail remains')
const runner = readFileSync(new URL('./live/runner.ts', import.meta.url), 'utf8')
assert.ok(runner.includes("(policy.briefPrefix ?? '') + task.brief + (policy.briefSuffix ?? '')"), 'the runner dispatches the tested policy suffix')
console.log('SOLO REVIEWER ROAD GREEN')
