/**
 * Static option/argument table for the `pyright` CLI, consumed by the
 * command-spec registry. Flag spellings and argument-placeholder names are
 * contract data (they interoperate with the third-party autocomplete-spec
 * package); the descriptions are informational.
 */
import type { CommandSpec } from '../registry.js'

const pyright: CommandSpec = {
  name: 'pyright',
  description: 'Type checker for Python',
  args: {
    name: 'files',
    description: 'Files or directories to analyze (overrides the config file)',
    isVariadic: true,
    isOptional: true,
  },
  options: [
    { name: ['--help', '-h'], description: 'Show help' },
    { name: '--version', description: 'Print the version and exit' },
    { name: ['--watch', '-w'], description: 'Continue to watch and re-analyze on change' },
    { name: ['--project', '-p'], description: 'Use the configuration file at this location', args: { name: 'FILE OR DIRECTORY' } },
    { name: '-', description: 'Read a file or directory list from stdin' },
    { name: '--createstub', description: 'Create a type stub for the named import', args: { name: 'IMPORT' } },
    { name: ['--typeshedpath', '-t'], description: 'Use typeshed type stubs at this location', args: { name: 'DIRECTORY' } },
    { name: '--verifytypes', description: 'Verify type completeness of the named import', args: { name: 'IMPORT' } },
    { name: '--ignoreexternal', description: 'Ignore external imports for verifytypes' },
    { name: '--pythonpath', description: 'Path to the Python interpreter', args: { name: 'FILE' } },
    { name: '--pythonplatform', description: 'Analyze for the given platform', args: { name: 'PLATFORM' } },
    { name: '--pythonversion', description: 'Analyze for the given Python version', args: { name: 'VERSION' } },
    { name: ['--venvpath', '-v'], description: 'Directory that contains virtual environments', args: { name: 'DIRECTORY' } },
    { name: '--outputjson', description: 'Output results in JSON format' },
    { name: '--verbose', description: 'Emit verbose diagnostics' },
    { name: '--stats', description: 'Print detailed performance stats' },
    { name: '--dependencies', description: 'Print import dependency information' },
    { name: '--level', description: 'Minimum diagnostic level', args: { name: 'LEVEL' } },
    { name: '--skipunannotated', description: 'Skip analysis of unannotated functions' },
    { name: '--warnings', description: 'Use exit code 1 when warnings are reported' },
    { name: '--threads', description: 'Use up to N threads', args: { name: 'N', isOptional: true } },
  ],
}

export default pyright
