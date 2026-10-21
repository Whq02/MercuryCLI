from __future__ import annotations
import asyncio
from typing import AsyncIterator
from .errors import MercuryWireError
from .generated import MAX_LINE_BYTES
from .parse import Issue


async def read_lines(stream: asyncio.StreamReader) -> AsyncIterator[str]:
    buffer = bytearray()
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            if buffer: yield buffer.decode('utf-8', errors='replace').lstrip('\ufeff')
            return
        start = 0
        while start < len(chunk):
            end = chunk.find(b'\n', start)
            part = chunk[start:] if end < 0 else chunk[start:end]
            buffer.extend(part)
            if len(buffer) > MAX_LINE_BYTES:
                raise MercuryWireError(buffer.decode('utf-8', errors='replace'), 'invalid', issues=[Issue('', f'line exceeds {MAX_LINE_BYTES} bytes')])
            if end < 0: break
            yield buffer.decode('utf-8', errors='replace').lstrip('\ufeff')
            buffer.clear()
            start = end + 1
