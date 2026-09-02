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
