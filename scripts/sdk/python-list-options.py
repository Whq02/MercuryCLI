import json
from mercury_cli_sdk.client import RunOptions, argv_of
from mercury_cli_sdk.errors import MercuryError

rows = []
for name in ['allowed_tools', 'block_tools', 'toolset', 'mcp', 'provider_preview']:
    for values in [['--sovereign'], ['Read', '--sovereign'], ['-d'], ['Read', 'Bash(git --version)']]:
        try:
            rows.append({'name': name, 'values': values, 'args': argv_of(RunOptions(mercury=['fixture'], prompt='hello', **{name: values}))[1:]})
        except MercuryError as error:
            rows.append({'name': name, 'values': values, 'error': str(error)})
print(json.dumps(rows))
