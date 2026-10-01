import json
import math
import os
import sys
import time

DEFAULT_PTY_MAX = 3


def positive_int(value, fallback):
    return int(value) if str(value).isdigit() and int(value) > 0 else fallback


def shape(env=None):
    env = os.environ if env is None else env
    cores = positive_int(env.get('MERCURY_GATE_CORES'), os.cpu_count() or 1)
    pty_max = positive_int(env.get('MERCURY_GATE_PTY_MAX'), DEFAULT_PTY_MAX)
    return cores, pty_max


def capture_slots(env=None):
    env = os.environ if env is None else env
    if env.get('MERCURY_GATE_PTY_MAX'):
        return shape(env)[1]
    try:
        return int(env.get('VSHOT_SLOTS', DEFAULT_PTY_MAX))
    except (ValueError, TypeError):
        return DEFAULT_PTY_MAX


def capture_slot_dir():
    return os.path.join(os.path.realpath('/tmp'), 'mercury-vshot-slots-%s' % os.getuid())


def start_reading(budget, env=None):
    env = os.environ if env is None else env
    cores, pty_max = shape(env)
    try:
        load = os.getloadavg()[0]
    except (AttributeError, OSError):
        load = None
    try:
        pace = float(env.get('MERCURY_VSHOT_BUDGET_SCALE', '1'))
    except (ValueError, TypeError):
        pace = 1.0
    if not math.isfinite(pace) or pace <= 0:
        pace = 1.0
    return dict(startedAt=time.time(), cores=cores, load1=load, ptyMax=pty_max,
                vshotSlots=capture_slots(env), paceKnob=pace, budgetScale=pace, budgetS=budget)


if __name__ == '__main__':
    if sys.argv[1:] == ['--shell']:
        print(*shape())
    elif len(sys.argv) == 4 and sys.argv[1] == '--start':
        reading = start_reading(int(sys.argv[3]))
        with open(sys.argv[2], 'w') as target:
            json.dump(reading, target)
        print('suite start: cores={cores} load1={load1} pace={paceKnob} scale={budgetScale} wall={budgetS}s pty={ptyMax} vshot={vshotSlots}'.format(**reading))
    else:
        sys.exit('usage: box_shape.py --shell | --start <receipt.json> <budget-seconds>')
