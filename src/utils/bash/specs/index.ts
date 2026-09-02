/**
 * Aggregates the locally-shipped command specs into one ordered list for the
 * command-spec registry. The order is the snapshot order: pyright, timeout,
 * sleep, alias, nohup, time, srun. Only pyright/srun/timeout are authored here
 * here; the other four are below the rewrite floor and remain in the tree.
 */
import type { CommandSpec } from '../registry.js'
import pyright from './pyright.js'
import timeout from './timeout.js'
import sleep from './sleep.js'
import alias from './alias.js'
import nohup from './nohup.js'
import time from './time.js'
import srun from './srun.js'

const localSpecs: CommandSpec[] = [pyright, timeout, sleep, alias, nohup, time, srun]

export default localSpecs
