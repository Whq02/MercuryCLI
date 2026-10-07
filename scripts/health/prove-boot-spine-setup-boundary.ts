#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const main = readFileSync(process.argv[2] ?? join(import.meta.dir, '../../src/main.tsx'), 'utf8')
const setupAt = main.indexOf('await showSetupScreens(')
const settingsAt = main.indexOf('await launchInvalidSettingsDialog(')
const arm = 'armBackgroundDiscovery();'
const armAt = main.indexOf(arm)
const beginAt = main.indexOf('markLaunchBegun();')
const resumeAt = main.indexOf('await launchResumeChooser(')
const chatAt = main.indexOf('await launchChat(')
let failures = 0
const check = (label: string, condition: boolean): void => {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}`)
  if (!condition) failures++
}

check('the existing milestone import supplies the launch boundary', main.includes("import { markLaunchBegun, recordLaunchMilestone } from './substrate/launchMilestones.js'"))
check('the launch boundary is called exactly once', beginAt !== -1 && main.split('markLaunchBegun();').length === 2)
check('the boundary immediately follows background-discovery arming', armAt !== -1 && beginAt > armAt && main.slice(armAt + arm.length, beginAt).trim() === '')
check('every setup sequence and the settings dialog precede the boundary', setupAt !== -1 && settingsAt !== -1 && setupAt < beginAt && settingsAt < beginAt)
check('the chooser and chat both follow the boundary', resumeAt !== -1 && chatAt !== -1 && beginAt !== -1 && beginAt < resumeAt && beginAt < chatAt)
console.log(failures === 0 ? '\nprove-boot-spine-setup-boundary: all green' : `\nprove-boot-spine-setup-boundary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
