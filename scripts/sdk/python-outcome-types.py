from typing import Literal, assert_type
from mercury_cli_sdk import run

async def consume() -> None:
    task = await run('Report the turn.')
    outcome = await task.outcome
    print([assert_type(recovery['kind'], Literal['announced_step', 'empty_reply']) for recovery in outcome.get('recoveries', [])])
    print([f"{ward['ward']}:{ward['effect']}" for ward in outcome.get('wards', [])])
    for ward in outcome.get('wards', []):
        assert_type(ward['ward'], str)
        assert_type(ward['tool'], str)
        assert_type(ward['effect'], Literal['refused', 'warned'])
