import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { observeSkillPackage } from './skill-package-identity'

const roots: string[] = []
const baseLimits = {
  maximumDepth: 4,
  maximumEntries: 8,
  maximumFiles: 4,
  maximumSingleFileBytes: 8,
  maximumTotalBytes: 16
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'orca-skill-observation-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe('skill package observation limits', () => {
  it.each([
    {
      name: 'depth',
      limits: { ...baseLimits, maximumDepth: 1 },
      prepare: async (directory: string) =>
        mkdir(join(directory, 'one', 'two'), { recursive: true }),
      error: 'skill-package-depth-limit'
    },
    {
      name: 'entries',
      limits: { ...baseLimits, maximumEntries: 1 },
      prepare: async (directory: string) => {
        await writeFile(join(directory, 'a'), 'a')
        await writeFile(join(directory, 'b'), 'b')
      },
      error: 'skill-package-entry-limit'
    },
    {
      name: 'files',
      limits: { ...baseLimits, maximumFiles: 1 },
      prepare: async (directory: string) => {
        await writeFile(join(directory, 'a'), 'a')
        await writeFile(join(directory, 'b'), 'b')
      },
      error: 'skill-package-file-count-limit'
    },
    {
      name: 'single file bytes',
      limits: { ...baseLimits, maximumSingleFileBytes: 1 },
      prepare: async (directory: string) => writeFile(join(directory, 'a'), 'ab'),
      error: 'skill-package-file-size-limit'
    },
    {
      name: 'aggregate bytes',
      limits: { ...baseLimits, maximumTotalBytes: 2 },
      prepare: async (directory: string) => {
        await writeFile(join(directory, 'a'), 'ab')
        await writeFile(join(directory, 'b'), 'c')
      },
      error: 'skill-package-total-size-limit'
    }
  ])('fails closed at the $name limit', async ({ limits, prepare, error }) => {
    const directory = await root()
    await prepare(directory)
    await expect(observeSkillPackage(directory, limits)).rejects.toThrow(error)
  })
})
