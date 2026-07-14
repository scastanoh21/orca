import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const COMPILER_OPTIONS = `            'VCCLCompilerTool': {
              'AdditionalOptions': [
                '/guard:cf',
                '/sdl',
                '/W3',
                '/w34244',
                '/w34267',
                '/ZH:SHA_256'
              ]
            }`

const REPRODUCIBLE_COMPILER_OPTIONS = `            'VCCLCompilerTool': {
              'AdditionalOptions': [
                '/guard:cf',
                '/sdl',
                '/W3',
                '/w34244',
                '/w34267',
                '/ZH:SHA_256',
                '/Brepro',
                '/experimental:deterministic'
              ]
            }`

const LINKER_OPTIONS = `            'VCLinkerTool': {
              'AdditionalOptions': [
                '/DYNAMICBASE',
                '/guard:cf'
              ]
            }`

const REPRODUCIBLE_LINKER_OPTIONS = `            'VCLinkerTool': {
              'AdditionalOptions': [
                '/DYNAMICBASE',
                '/guard:cf',
                '/Brepro',
                '/experimental:deterministic'
              ]
            }`

export async function applyWindowsNodePtyBuildDeterminism({ nodePtyDirectory, tuple }) {
  if (!tuple.startsWith('win32-')) {
    return false
  }
  const bindingPath = join(nodePtyDirectory, 'binding.gyp')
  const source = await readFile(bindingPath, 'utf8')
  if (
    source.split(COMPILER_OPTIONS).length !== 2 ||
    source.split(LINKER_OPTIONS).length !== 2 ||
    source.includes("'/Brepro'") ||
    source.includes("'/experimental:deterministic'")
  ) {
    throw new Error('node-pty Windows build settings do not match the reviewed source')
  }
  // Why: ARM64 compiler output changes even with a reproducible linker unless both stages opt in.
  const reproducibleSource = source
    .replace(COMPILER_OPTIONS, REPRODUCIBLE_COMPILER_OPTIONS)
    .replace(LINKER_OPTIONS, REPRODUCIBLE_LINKER_OPTIONS)
  await writeFile(bindingPath, reproducibleSource, 'utf8')
  return true
}
