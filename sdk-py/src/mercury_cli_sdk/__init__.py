"""Mercury CLI SDK: typed clients for ``mercury run`` (rows) and ``mercury runner`` (hosted JSON-RPC sessions)."""
from .generated import *
from .generated import __all__ as _generated_exports
from .errors import Door, MercuryError, MercuryRefusal, MercuryUsageError, MercuryExitError, MercurySpawnError, MercuryWireError, RunExit
from .parse import Issue, PromptContent, PromptInput, RowRead, StreamRow, UnknownRow, assert_completed, is_input_row_type, is_main_thread, is_outcome, is_retryable_outcome, is_row_type, is_session_row, main_thread_step, outcome_error_text, outcome_failed, turn_opened, turn_waiting, validate, row_of, parse_row, input_row_of
from .client import ConnectKwargs, Listener, RunKwargs, RunOptions, MercuryRun, TypedRun, argv_of, run
from .runner import ReadTextFileHandler, WriteTextFileHandler, ElicitationHandler, HostHandler, MercurySession, PermissionHandler, RequestContext, connect, prewarm
from .sync import RunResult, SyncSession, connect_sync, run_sync
from .helpers import allow_permission, deny_permission, text_block, image_block, AgentDefinition, ToolDefinition, ToolContext, ToolResult, ToolServer, define_agent, define_tool, serve_tools
from .version import __version__
from .structured import StructuredSchema, TypedRunResult, structured_schema, MercurySchemaError, schema_refusal, validate_outcome
from .support import FEATURE_FLOORS, RunnerFeature, RunnerSupport, compare_versions, parse_version, runner_support

__all__ = [*_generated_exports, 'Door', 'MercuryError', 'MercuryRefusal', 'MercuryUsageError', 'MercuryExitError', 'MercurySpawnError', 'MercuryWireError', 'RunExit', 'Issue', 'PromptContent', 'PromptInput', 'RowRead', 'StreamRow', 'UnknownRow', 'assert_completed', 'is_input_row_type', 'is_main_thread', 'is_outcome', 'is_retryable_outcome', 'is_row_type', 'is_session_row', 'main_thread_step', 'outcome_error_text', 'outcome_failed', 'turn_opened', 'turn_waiting', 'validate', 'row_of', 'parse_row', 'input_row_of', 'Listener', 'ConnectKwargs', 'RunKwargs', 'StructuredSchema', 'TypedRunResult', 'structured_schema', 'MercurySchemaError', 'schema_refusal', 'validate_outcome', 'FEATURE_FLOORS', 'RunnerFeature', 'RunnerSupport', 'compare_versions', 'parse_version', 'runner_support', 'TypedRun', 'RunOptions', 'MercuryRun', 'argv_of', 'run', 'ReadTextFileHandler', 'WriteTextFileHandler', 'ElicitationHandler', 'HostHandler', 'MercurySession', 'PermissionHandler', 'RequestContext', 'connect', 'prewarm', 'RunResult', 'SyncSession', 'connect_sync', 'run_sync', 'allow_permission', 'deny_permission', 'text_block', 'image_block', 'AgentDefinition', 'ToolDefinition', 'ToolContext', 'ToolResult', 'ToolServer', 'define_agent', 'define_tool', 'serve_tools', '__version__']
