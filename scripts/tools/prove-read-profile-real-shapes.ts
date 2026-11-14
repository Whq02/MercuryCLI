import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome, readViewKit } from './readViewKit.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const sample = join(home, 'workers.sample.txt')
writeFileSync(sample, `Analysis of sampling node (pid 4242) every 1 millisecond
Process:         node [4242]
Report Version:  7

Call graph:
    30 Thread_1001   DispatchQueue_1: com.apple.main-thread  (serial)
    + 30 start  (in dyld) + 6076  [0x18c0a1a8c]
    +   30 node::Start(int, char**)  (in node) + 480  [0x1000a2b3c]
    +     28 ???  (in <unknown binary>)  [0x10a8f4c20]
    +     2 uv_run  (in node) + 420  [0x100c5e2a4]
    +       2 kevent  (in libsystem_kernel.dylib) + 8  [0x18c3f1d08]
    30 Thread_1002: DelayedTaskSchedulerWorker
    + 30 thread_start  (in libsystem_pthread.dylib) + 8  [0x18c42acec]
    +   30 _pthread_start  (in libsystem_pthread.dylib) + 136  [0x18c42fd00]
    +     30 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x18c3f55f4]
    30 Thread_1003: V8Worker
    + 30 thread_start  (in libsystem_pthread.dylib) + 8  [0x18c42acec]
    +   30 _pthread_start  (in libsystem_pthread.dylib) + 136  [0x18c42fd00]
    +     25 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x18c3f55f4]
    +     5 Thread_pool_run(void*)  (in node) + 12  [0x100b01f2c]
    30 Thread_1004: SignalInspector
      30 thread_start  (in libsystem_pthread.dylib) + 8  [0x18c42acec]
        30 _pthread_start  (in libsystem_pthread.dylib) + 136  [0x18c42fd00]
          30 semaphore_wait_trap  (in libsystem_kernel.dylib) + 8  [0x18c3ecc20]

Total number in stack (recursive counted multiple, when >=5):
        4       thread_start  (in libsystem_pthread.dylib) + 0  [0x18c42ace4]
`)
const report = await kit.read(sample)
const threads = report.split('\n').filter(line => line.startsWith('thread: '))
kit.check('a real sampling report keeps one row for each of its threads', threads.length === 4, threads.join(' | '))
kit.check('each thread row carries the heading the report gave that thread', ['Thread_1001   DispatchQueue_1: com.apple.main-thread  (serial)', 'Thread_1002: DelayedTaskSchedulerWorker', 'Thread_1003: V8Worker', 'Thread_1004: SignalInspector'].every((name, index) => threads[index]?.startsWith(`thread: ${name} · `)), threads.join(' | '))
kit.check('the frame every worker thread begins with is never a thread', !threads.some(line => line.includes('thread_start')) && !threads.some(line => line.includes('Thread_pool_run')), threads.join(' | '))
kit.check('a worker that ran keeps its own active and waiting samples', threads[2]?.includes('· active · active=5 samples · wait=25 samples · dominant wait=__psynch_cvwait') === true, threads[2])
kit.check('a worker that only waited is told apart from the one that ran', threads[1]?.includes('· waiting · active=0 samples · wait=30 samples') === true && threads[3]?.includes('dominant wait=semaphore_wait_trap') === true, `${threads[1]} | ${threads[3]}`)
kit.check('the totals are those of the report', report.includes('samples: 120 ·') && report.includes('on-CPU estimate: 33 samples · idle: 87 samples'), report.split('\n').slice(2, 4).join(' | '))
kit.check('the worker frame is a frame of its hot path', report.includes('hot path: Thread_1003: V8Worker: thread_start → _pthread_start → Thread_pool_run(void*) · self contributions=5 samples'), report.split('\n').filter(line => line.startsWith('hot path')).join(' | '))
kit.finish()
