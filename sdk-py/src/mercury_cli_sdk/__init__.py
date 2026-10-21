"""Mercury CLI SDK: typed clients for ``mercury run`` (rows) and ``mercury runner`` (hosted JSON-RPC sessions)."""
from .generated import *
from .generated import __all__ as _generated_exports
from .errors import Door, MercuryError, MercuryRefusal, MercuryUsageError, MercuryExitError, MercurySpawnError, MercuryWireError, RunExit
from .parse import Issue, RowRead, StreamRow, UnknownRow, is_main_thread, validate, row_of, parse_row, input_row_of
from .client import Listener, RunOptions, MercuryRun, TypedRun, argv_of, run
from .runner import ReadTextFileHandler, WriteTextFileHandler, ElicitationHandler, HostHandler, MercurySession, PermissionHandler, RequestContext, connect, prewarm
from .sync import RunResult, SyncSession, connect_sync, run_sync
from .helpers import text_block, image_block, AgentDefinition, ToolDefinition, ToolContext, ToolResult, ToolServer, define_agent, define_tool, serve_tools
from .version import __version__
from .structured import StructuredSchema, structured_schema, MercurySchemaError, validate_outcome

__all__ = [*_generated_exports, 'Door', 'MercuryError', 'MercuryRefusal', 'MercuryUsageError', 'MercuryExitError', 'MercurySpawnError', 'MercuryWireError', 'RunExit', 'Issue', 'RowRead', 'StreamRow', 'UnknownRow', 'is_main_thread', 'validate', 'row_of', 'parse_row', 'input_row_of', 'Listener', 'StructuredSchema', 'structured_schema', 'MercurySchemaError', 'validate_outcome', 'TypedRun', 'RunOptions', 'MercuryRun', 'argv_of', 'run', 'ReadTextFileHandler', 'WriteTextFileHandler', 'ElicitationHandler', 'HostHandler', 'MercurySession', 'PermissionHandler', 'RequestContext', 'connect', 'prewarm', 'RunResult', 'SyncSession', 'connect_sync', 'run_sync', 'text_block', 'image_block', 'AgentDefinition', 'ToolDefinition', 'ToolContext', 'ToolResult', 'ToolServer', 'define_agent', 'define_tool', 'serve_tools', '__version__']
