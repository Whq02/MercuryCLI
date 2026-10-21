import asyncio
from mercury_cli_sdk import connect, connect_sync, prewarm, run, run_sync


async def wrong() -> None:
    await run('x', nope=1)
    await run('x', mode='yolo')
    await connect(prompt='x')
    await connect(effort='extreme')
    await prewarm(warm=True)
    run_sync('x', max_turns='three')
    connect_sync(mercury=3)


if __name__ == '__main__':
    try: asyncio.run(wrong())
    except TypeError: pass
