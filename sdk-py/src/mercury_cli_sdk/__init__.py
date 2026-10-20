"""Mercury CLI SDK: typed clients for ``mercury run`` (rows) and ``mercury runner`` (hosted JSON-RPC sessions)."""
from .generated import *
from .generated import __all__ as _generated_exports
from .errors import Door, MercuryError, MercuryRefusal, MercuryUsageError, MercuryExitError, MercurySpawnError, MercuryWireError, RunExit
from .parse import Issue, RowRead, StreamRow, UnknownRow, is_main_thread, validate, row_of, parse_row, input_row_of
from .client import Listener, RunOptions, MercuryRun, argv_of, run
from .runner import ElicitationHandler, HostHandler, MercurySession, PermissionHandler, RequestContext, connect
from .sync import RunResult, SyncSession, connect_sync, run_sync
from .helpers import AgentDefinition, ToolDefinition, ToolResult, ToolServer, define_agent, define_tool, serve_tools
from .version import __version__

__all__ = [*_generated_exports, 'Door', 'MercuryError', 'MercuryRefusal', 'MercuryUsageError', 'MercuryExitError', 'MercurySpawnError', 'MercuryWireError', 'RunExit', 'Issue', 'RowRead', 'StreamRow', 'UnknownRow', 'is_main_thread', 'validate', 'row_of', 'parse_row', 'input_row_of', 'Listener', 'RunOptions', 'MercuryRun', 'argv_of', 'run', 'ElicitationHandler', 'HostHandler', 'MercurySession', 'PermissionHandler', 'RequestContext', 'connect', 'RunResult', 'SyncSession', 'connect_sync', 'run_sync', 'AgentDefinition', 'ToolDefinition', 'ToolResult', 'ToolServer', 'define_agent', 'define_tool', 'serve_tools', '__version__']
