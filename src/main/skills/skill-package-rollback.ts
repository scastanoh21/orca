import { lstat, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ManagedSkillDestination, SkillReleasedSnapshot } from '../../shared/skill-management'
import type { PublicationCallbacks } from './skill-package-publication'
import { publishSkillFileThroughOwnedTemp } from './skill-owned-temp-publication'
import type { SkillOwnedTempRuntime } from './skill-owned-temp-publication'
import { skillInPlaceOperations } from './skill-transaction-publication-state'
import type { SkillInPlacePublicationState } from './skill-transaction-publication-state'

export async function clearSkillPublicationTemporary(args: {
  record: ManagedSkillDestination
  publication: SkillInPlacePublicationState
  callbacks: PublicationCallbacks
  ownedTempRuntime?: SkillOwnedTempRuntime
}): Promise<void> {
  if (!args.publication.temporary) {
    return
  }
  await args.callbacks.assertBoundary(args.publication)
  const temporaryPath = join(
    args.record.resolvedPath,
    ...args.publication.temporary.path.split('/')
  )
  if (await lstat(temporaryPath).catch(() => null)) {
    await args.callbacks.assertBoundary(args.publication)
    await unlink(temporaryPath)
  }
  await args.callbacks.journal({ ...args.publication, temporary: null })
}

export async function rollbackSkillPackageInPlace(args: {
  record: ManagedSkillDestination
  prior: SkillReleasedSnapshot
  current: SkillReleasedSnapshot
  backupRoot: string
  startingIndex: number
  physicalIdentity: string
  callbacks: PublicationCallbacks
  ownedTempRuntime?: SkillOwnedTempRuntime
}): Promise<void> {
  const operations = skillInPlaceOperations(args.prior, args.current)
  const priorByPath = new Map(args.prior.files.map((file) => [file.path, file]))
  for (let operationIndex = args.startingIndex; operationIndex > 0; operationIndex -= 1) {
    const operation = operations[operationIndex - 1]
    if (!operation) {
      throw new Error('skill-publication-operation-invalid')
    }
    const priorFile = priorByPath.get(operation.path)
    const applying = {
      kind: 'in-place',
      direction: 'rollback',
      physicalIdentity: args.physicalIdentity,
      temporary: null,
      operationIndex,
      operationState: 'applying'
    } as const
    await args.callbacks.journal(applying)
    const livePath = join(args.record.resolvedPath, ...operation.path.split('/'))
    if (operation.kind === 'publish' && !priorFile) {
      await args.callbacks.assertBoundary(applying)
      await unlink(livePath)
    } else {
      if (!priorFile) {
        throw new Error('skill-publication-operation-invalid')
      }
      await publishSkillFileThroughOwnedTemp({
        destinationRoot: args.record.resolvedPath,
        sourcePath: join(args.backupRoot, ...priorFile.path.split('/')),
        expectedFile: priorFile,
        direction: 'rollback',
        packagePhysicalIdentity: args.physicalIdentity,
        operationIndex,
        callbacks: args.callbacks,
        runtime: args.ownedTempRuntime
      })
    }
    const ready = {
      kind: 'in-place',
      direction: 'rollback',
      physicalIdentity: args.physicalIdentity,
      temporary: null,
      operationIndex: operationIndex - 1,
      operationState: 'ready'
    } as const
    await args.callbacks.journal(ready)
    if (operation.kind === 'publish' && !priorFile) {
      let parent = dirname(livePath)
      while (parent !== args.record.resolvedPath) {
        await args.callbacks.assertBoundary(ready)
        await rmdir(parent).catch(() => undefined)
        parent = dirname(parent)
      }
    }
  }
}
