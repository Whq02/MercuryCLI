import asyncio
import json
import sys
import time
from mercury_cli_sdk import connect


async def main():
    mercury = json.loads(sys.argv[1])
    cwd = sys.argv[2]
    sid = sys.argv[3]
    hook_seconds = float(sys.argv[4])
    words = sys.argv[5]
    reply = sys.argv[6]
    async with await connect(mercury=mercury, cwd=cwd, warm=True, timeout=60) as warm:
        assert warm.session_id is None
        started = time.monotonic()
        receipt = await warm.claim(session_id=sid, resume=True)
        waited = time.monotonic() - started
        assert receipt['session_id'] == sid == warm.session_id, (receipt, warm.session_id)
        assert waited >= hook_seconds, f'the claim resolved after {waited:.1f}s, before the {hook_seconds:.0f}s load'
        prompted = time.monotonic()
        outcome = await warm.prompt(words, timeout=60)
        assert outcome['status'] == 'completed' and outcome.get('answer') == reply, outcome
        assert time.monotonic() - prompted < hook_seconds, 'the prompt waited for the load; the claim should have'
    print(f'PASS python: claim(resume=True) resolved after the load ({waited:.1f}s) and the first prompt completed')


asyncio.run(main())
