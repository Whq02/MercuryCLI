import asyncio
import json
import sys
import uuid
from mercury_cli_sdk import MercuryError, MercuryOutcomeError, MercuryRefusal, assert_completed, connect, prewarm


async def main():
    mercury = json.loads(sys.argv[1])
    cwd = sys.argv[2]
    missing = str(uuid.uuid4())
    async with await prewarm(mercury=mercury, cwd=cwd, timeout=30) as warm:
        try: await warm.claim(session_id=missing, resume=True)
        except MercuryRefusal as error:
            assert error.code == -32010 and error.data['kind'] == 'claim'
            assert missing in str(error) and 'no conversation found' in str(error)
        else: raise AssertionError('a missing conversation was resumed')
        assert warm.session_id is None
    try: await connect(mercury=mercury, cwd=cwd, resume=missing, timeout=30)
    except MercuryError as error: assert 'found' in str(error).lower(), str(error)
    else: raise AssertionError('cold resume created a missing session')
    async with await connect(mercury=mercury, cwd=cwd, mode='dontAsk', ephemeral=True, timeout=30) as session:
        outcome = await session.prompt('Write not-written.txt', timeout=30)
        assert outcome['status'] == 'blocked' and outcome['denials']
        try: assert_completed(outcome)
        except MercuryOutcomeError as error:
            assert error.outcome is outcome and error.error_class == 'blocked' and error.detail
            assert 'Write' in str(error) and any(word in str(error) for word in ('allowed-tools', 'mode', 'host'))
        else: raise AssertionError('an unanswered permission ask was not catchable')


asyncio.run(main())
