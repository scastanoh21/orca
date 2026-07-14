import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applyWindowsNodePtyBuildDeterminism,
  assertWindowsNodePtyGeneratedBuildSettings,
  inspectWindowsNodePtyLinkCommandTracking,
  parseWindowsNodePtyLinkCommandTracking,
  windowsNodePtyLinkCommandTrackingPath
} from './ssh-relay-node-pty-windows-build-determinism.mjs'

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function copiedSource() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-node-pty-windows-determinism-'))
  temporaryDirectories.push(directory)
  await cp(resolve('node_modules/node-pty/binding.gyp'), join(directory, 'binding.gyp'))
  return directory
}

async function generatedProject({
  compilerOptions = '/Brepro /experimental:deterministic %(AdditionalOptions)',
  linkerOptions = '/Brepro /experimental:deterministic %(AdditionalOptions)',
  platform = 'ARM64'
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-node-pty-windows-msbuild-'))
  temporaryDirectories.push(directory)
  await mkdir(join(directory, 'build'))
  await writeFile(
    join(directory, 'build', 'conpty_console_list.vcxproj'),
    `<Project><ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|${platform}'"><ClCompile><AdditionalOptions>${compilerOptions}</AdditionalOptions></ClCompile><Link><AdditionalOptions>${linkerOptions}</AdditionalOptions></Link></ItemDefinitionGroup></Project>`
  )
  return directory
}

describe('SSH relay Windows node-pty build determinism', () => {
  it('adds deterministic MSVC compilation and linking only to the copied Windows source', async () => {
    const directory = await copiedSource()
    const repositorySource = await readFile(resolve('node_modules/node-pty/binding.gyp'), 'utf8')
    await expect(
      applyWindowsNodePtyBuildDeterminism({ nodePtyDirectory: directory, tuple: 'win32-arm64' })
    ).resolves.toBe(true)
    const source = await readFile(join(directory, 'binding.gyp'), 'utf8')
    const compilerStart = source.indexOf("'VCCLCompilerTool'")
    const linkerStart = source.indexOf("'VCLinkerTool'")
    const compilerOptions = source.slice(compilerStart, linkerStart)
    const linkerOptions = source.slice(linkerStart)
    expect(compilerOptions).toContain("'/Brepro'")
    expect(compilerOptions).toContain("'/experimental:deterministic'")
    expect(linkerOptions).toContain("'/Brepro'")
    expect(linkerOptions).toContain("'/experimental:deterministic'")
    expect(await readFile(resolve('node_modules/node-pty/binding.gyp'), 'utf8')).toBe(
      repositorySource
    )
  })

  it('leaves POSIX source untouched and rejects an unexpected Windows source shape', async () => {
    const directory = await copiedSource()
    const original = await readFile(join(directory, 'binding.gyp'), 'utf8')
    await expect(
      applyWindowsNodePtyBuildDeterminism({ nodePtyDirectory: directory, tuple: 'darwin-arm64' })
    ).resolves.toBe(false)
    expect(await readFile(join(directory, 'binding.gyp'), 'utf8')).toBe(original)

    await writeFile(join(directory, 'binding.gyp'), '{}', 'utf8')
    await expect(
      applyWindowsNodePtyBuildDeterminism({ nodePtyDirectory: directory, tuple: 'win32-x64' })
    ).rejects.toThrow('do not match the reviewed source')
  })

  it('proves the generated Release project propagates compile and link settings', async () => {
    const directory = await generatedProject({ platform: 'arm64' })
    await expect(
      assertWindowsNodePtyGeneratedBuildSettings({
        nodePtyDirectory: directory,
        tuple: 'win32-arm64'
      })
    ).resolves.toEqual({
      configuration: 'Release|ARM64',
      compilerOptions: ['/Brepro', '/experimental:deterministic'],
      linkerOptions: ['/Brepro', '/experimental:deterministic'],
      project: 'conpty_console_list.vcxproj'
    })
  })

  it('parses one bounded UTF-16 linker command into an allowlisted switch summary', () => {
    expect(
      windowsNodePtyLinkCommandTrackingPath({
        nodePtyDirectory: 'C:\\artifact-node-pty',
        tuple: 'win32-arm64'
      })
    ).toBe(
      join(
        'C:\\artifact-node-pty',
        'build',
        'Release',
        'obj',
        'conpty_console_list',
        'conpty_console_list.tlog',
        'link.command.1.tlog'
      )
    )
    const command = [
      '^C:\\artifact-node-pty\\build\\Release\\obj\\conpty_console_list.obj',
      '/OUT:conpty_console_list.node /INCREMENTAL:NO /GUARD:CF /DEBUG:FULL',
      '/OPT:REF /OPT:ICF /Brepro /experimental:deterministic'
    ].join('\r\n')
    expect(
      parseWindowsNodePtyLinkCommandTracking(Buffer.from(`\ufeff${command}`, 'utf16le'))
    ).toEqual({
      bytes: Buffer.byteLength(`\ufeff${command}`, 'utf16le'),
      commandRecords: 1,
      encoding: 'utf16le',
      incremental: 'disabled',
      switches: [
        '/brepro',
        '/debug:full',
        '/experimental:deterministic',
        '/guard:cf',
        '/incremental:no',
        '/opt:icf',
        '/opt:ref'
      ]
    })
    expect(
      windowsNodePtyLinkCommandTrackingPath({
        nodePtyDirectory: '/not-used-on-posix',
        tuple: 'linux-arm64-glibc'
      })
    ).toBeUndefined()
  })

  it('rejects oversized, malformed, duplicate, or ambiguous linker tracking input', () => {
    expect(() => parseWindowsNodePtyLinkCommandTracking(Buffer.alloc(300_000))).toThrow(
      'outside the bounded size'
    )
    expect(() =>
      parseWindowsNodePtyLinkCommandTracking(Buffer.from([0xff, 0xfe, 0x00, 0xd8]))
    ).toThrow('invalid text encoding')
    expect(() =>
      parseWindowsNodePtyLinkCommandTracking(
        Buffer.from('^first\n/INCREMENTAL\n^second\n/INCREMENTAL', 'utf8')
      )
    ).toThrow('exactly one command record')
    expect(() =>
      parseWindowsNodePtyLinkCommandTracking(
        Buffer.from(
          '^one\n/INCREMENTAL /INCREMENTAL:NO /Brepro /GUARD:CF /experimental:deterministic',
          'utf8'
        )
      )
    ).toThrow('ambiguous incremental-link switches')
    expect(() =>
      parseWindowsNodePtyLinkCommandTracking(
        Buffer.from('^one\n/INCREMENTAL:MAYBE /Brepro /GUARD:CF /experimental:deterministic')
      )
    ).toThrow('malformed incremental-link switch')
    expect(() =>
      parseWindowsNodePtyLinkCommandTracking(
        Buffer.from('^one\n/Brepro /BREPRO /GUARD:CF /experimental:deterministic')
      )
    ).toThrow('duplicate allowlisted switches')
    expect(() =>
      parseWindowsNodePtyLinkCommandTracking(Buffer.from('^one\n/Brepro /GUARD:CF', 'utf8'))
    ).toThrow('missing /experimental:deterministic')
  })

  it('bounds linker tracking bytes while reading the generated file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-node-pty-link-tracking-'))
    temporaryDirectories.push(directory)
    const trackingPath = join(directory, 'link.command.1.tlog')
    await writeFile(
      trackingPath,
      '^one\n/INCREMENTAL:NO /Brepro /GUARD:CF /experimental:deterministic'
    )
    await expect(inspectWindowsNodePtyLinkCommandTracking(trackingPath)).resolves.toMatchObject({
      incremental: 'disabled'
    })
    await writeFile(trackingPath, Buffer.alloc(300_000))
    await expect(inspectWindowsNodePtyLinkCommandTracking(trackingPath)).rejects.toThrow(
      'outside the bounded size'
    )
  })

  it('rejects missing, duplicate, non-inherited, or wrong-architecture generated settings', async () => {
    for (const fixture of [
      { compilerOptions: '/Brepro %(AdditionalOptions)' },
      { linkerOptions: '/Brepro /Brepro /experimental:deterministic %(AdditionalOptions)' },
      { linkerOptions: '/Brepro /experimental:deterministic' },
      { platform: 'x64' }
    ]) {
      const directory = await generatedProject(fixture)
      await expect(
        assertWindowsNodePtyGeneratedBuildSettings({
          nodePtyDirectory: directory,
          tuple: 'win32-arm64'
        })
      ).rejects.toThrow(/generated MSBuild settings/i)
    }
    await expect(
      assertWindowsNodePtyGeneratedBuildSettings({
        nodePtyDirectory: '/not-used-on-posix',
        tuple: 'darwin-arm64'
      })
    ).resolves.toBeUndefined()
  })
})
