import type { SkillBundleFileIdentity, SkillReleasedSnapshot } from '../../shared/skill-management'
import { matchesFileIdentity, type ObservedSkillPackage } from './skill-package-identity'

export type SkillInPlacePublicationState = {
  kind: 'in-place'
  direction: 'forward' | 'rollback'
  physicalIdentity: string
  temporary: SkillPublicationTemporary | null
  operationIndex: number
  operationState: 'ready' | 'applying'
}

export type SkillPublicationTemporary = {
  path: string
  physicalIdentity: string
  expectedFile: SkillBundleFileIdentity
  state: 'creating' | 'written' | 'ready' | 'applied'
}

export type SkillPackageSwapState = {
  kind: 'package-swap'
  step:
    | 'moving-live'
    | 'live-moved'
    | 'moving-stage'
    | 'stage-moved'
    | 'rollback-moving-current'
    | 'rollback-current-moved'
    | 'rollback-moving-old-live'
    | 'complete'
}

export type SkillPublicationState = SkillInPlacePublicationState | SkillPackageSwapState

export type SkillInPlaceOperation = {
  kind: 'publish' | 'remove'
  path: string
}

function sameFileIdentity(
  left: SkillBundleFileIdentity | undefined,
  right: SkillBundleFileIdentity
): boolean {
  return Boolean(
    left &&
    left.path === right.path &&
    left.executable === right.executable &&
    left.classification === right.classification &&
    left.identitySha256 === right.identitySha256
  )
}

export function sameCompleteFileIdentity(
  left: SkillBundleFileIdentity | undefined,
  right: SkillBundleFileIdentity
): boolean {
  return Boolean(
    sameFileIdentity(left, right) &&
    left?.size === right.size &&
    left.exactSha256 === right.exactSha256 &&
    left.textNormalizedSha256 === right.textNormalizedSha256
  )
}

export function skillInPlaceOperations(
  prior: SkillReleasedSnapshot,
  current: SkillReleasedSnapshot
): SkillInPlaceOperation[] {
  const priorByPath = new Map(prior.files.map((file) => [file.path, file]))
  const currentPaths = new Set(current.files.map((file) => file.path))
  const changed = current.files
    .filter((file) => !sameFileIdentity(priorByPath.get(file.path), file))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const entryPoint = changed.filter((file) => file.path === 'SKILL.md')
  const assets = changed.filter((file) => file.path !== 'SKILL.md')
  const obsolete = prior.files
    .filter((file) => !currentPaths.has(file.path))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return [
    ...assets.map((file) => ({ kind: 'publish' as const, path: file.path })),
    ...entryPoint.map((file) => ({ kind: 'publish' as const, path: file.path })),
    ...obsolete.map((file) => ({ kind: 'remove' as const, path: file.path }))
  ]
}

function expectedFilesAfter(
  prior: SkillReleasedSnapshot,
  current: SkillReleasedSnapshot,
  completedOperations: number
): SkillBundleFileIdentity[] {
  const files = new Map(prior.files.map((file) => [file.path, file]))
  const currentByPath = new Map(current.files.map((file) => [file.path, file]))
  for (const operation of skillInPlaceOperations(prior, current).slice(0, completedOperations)) {
    if (operation.kind === 'remove') {
      files.delete(operation.path)
    } else {
      const next = currentByPath.get(operation.path)
      if (next) {
        files.set(operation.path, next)
      }
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function matchesExactFiles(
  observed: ObservedSkillPackage,
  expected: readonly SkillBundleFileIdentity[]
): boolean {
  return (
    observed.files.length === expected.length &&
    expected.every((file, index) => {
      const actual = observed.files[index]
      return Boolean(actual && matchesFileIdentity(actual, file))
    })
  )
}

export function matchingInPlaceOperationIndex(args: {
  observed: ObservedSkillPackage
  prior: SkillReleasedSnapshot
  current: SkillReleasedSnapshot
}): number | null {
  const operationCount = skillInPlaceOperations(args.prior, args.current).length
  for (let index = 0; index <= operationCount; index += 1) {
    if (matchesExactFiles(args.observed, expectedFilesAfter(args.prior, args.current, index))) {
      return index
    }
  }
  return null
}

export function matchesInPlacePublicationState(args: {
  observed: ObservedSkillPackage
  prior: SkillReleasedSnapshot
  current: SkillReleasedSnapshot
  publication: SkillInPlacePublicationState
  allowAppliedOperation: boolean
}): boolean {
  const operations = skillInPlaceOperations(args.prior, args.current)
  if (args.publication.operationIndex < 0 || args.publication.operationIndex > operations.length) {
    return false
  }
  let observed = args.observed
  const operation =
    operations[
      args.publication.direction === 'forward'
        ? args.publication.operationIndex
        : args.publication.operationIndex - 1
    ]
  const expectedTemporaryFile =
    operation &&
    (args.publication.direction === 'forward'
      ? args.current.files.find((file) => file.path === operation.path)
      : args.prior.files.find((file) => file.path === operation.path))
  let temporaryPresent = false
  if (args.publication.temporary) {
    const temporary = observed.files.find((file) => file.path === args.publication.temporary?.path)
    temporaryPresent = Boolean(temporary)
    if (
      !expectedTemporaryFile ||
      !sameCompleteFileIdentity(args.publication.temporary.expectedFile, expectedTemporaryFile) ||
      (temporary &&
        args.publication.temporary.state === 'written' &&
        !matchesFileIdentity(
          {
            ...temporary,
            executable: args.publication.temporary.expectedFile.executable
          },
          {
            ...args.publication.temporary.expectedFile,
            path: args.publication.temporary.path
          }
        )) ||
      (temporary &&
        (args.publication.temporary.state === 'ready' ||
          args.publication.temporary.state === 'applied') &&
        !matchesFileIdentity(temporary, {
          ...args.publication.temporary.expectedFile,
          path: args.publication.temporary.path
        }))
    ) {
      return false
    }
    if (temporary) {
      observed = { ...observed, files: observed.files.filter((file) => file !== temporary) }
    }
  }
  const candidates = [args.publication.operationIndex]
  const operationCanHaveApplied =
    operation?.kind === 'remove' ||
    args.publication.temporary?.state === 'ready' ||
    args.publication.temporary?.state === 'applied'
  if (
    (args.allowAppliedOperation || args.publication.temporary?.state === 'applied') &&
    operationCanHaveApplied &&
    args.publication.operationState === 'applying' &&
    (args.publication.direction === 'forward'
      ? args.publication.operationIndex < operations.length
      : args.publication.operationIndex > 0)
  ) {
    const appliedIndex =
      args.publication.direction === 'forward'
        ? args.publication.operationIndex + 1
        : args.publication.operationIndex - 1
    candidates.push(appliedIndex)
    if (args.publication.temporary && !temporaryPresent) {
      candidates.shift()
    }
  }
  if (
    args.publication.temporary &&
    !temporaryPresent &&
    (!args.allowAppliedOperation || args.publication.temporary.state === 'creating') &&
    args.publication.temporary.state !== 'applied'
  ) {
    return false
  }
  return candidates
    .filter((count) => count >= 0)
    .some((count) =>
      matchesExactFiles(observed, expectedFilesAfter(args.prior, args.current, count))
    )
}
