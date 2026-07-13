import { posix } from 'node:path'
import type { SkillBundleFileIdentity, SkillReleasedSnapshot } from '../../shared/skill-management'
import { skillPackageDigest } from './skill-package-identity'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function isSkillBundleFileIdentity(value: unknown): value is SkillBundleFileIdentity {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const file = value as Partial<SkillBundleFileIdentity>
  return (
    typeof file.path === 'string' &&
    file.path.length > 0 &&
    !file.path.includes('\\') &&
    !posix.isAbsolute(file.path) &&
    posix.normalize(file.path) === file.path &&
    !file.path.split('/').includes('..') &&
    typeof file.size === 'number' &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    typeof file.executable === 'boolean' &&
    (file.classification === 'text' || file.classification === 'binary') &&
    typeof file.exactSha256 === 'string' &&
    SHA256_PATTERN.test(file.exactSha256) &&
    (file.textNormalizedSha256 === null ||
      (typeof file.textNormalizedSha256 === 'string' &&
        SHA256_PATTERN.test(file.textNormalizedSha256))) &&
    typeof file.identitySha256 === 'string' &&
    SHA256_PATTERN.test(file.identitySha256) &&
    (file.classification !== 'text' || file.textNormalizedSha256 !== null) &&
    file.identitySha256 ===
      (file.classification === 'text' && !file.executable
        ? file.textNormalizedSha256
        : file.exactSha256)
  )
}

export function isSkillReleasedSnapshot(value: unknown): value is SkillReleasedSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const snapshot = value as Partial<SkillReleasedSnapshot>
  const structurallyValid =
    typeof snapshot.releaseRevision === 'number' &&
    Number.isSafeInteger(snapshot.releaseRevision) &&
    snapshot.releaseRevision >= 0 &&
    typeof snapshot.packageDigest === 'string' &&
    SHA256_PATTERN.test(snapshot.packageDigest) &&
    typeof snapshot.gitTreeSha === 'string' &&
    Array.isArray(snapshot.files) &&
    snapshot.files.every(isSkillBundleFileIdentity)
  if (!structurallyValid) {
    return false
  }
  const files = snapshot.files as SkillBundleFileIdentity[]
  const paths = files.map((file) => file.path)
  return (
    paths.every((path, index) => index === 0 || paths[index - 1]!.localeCompare(path, 'en') < 0) &&
    snapshot.packageDigest === skillPackageDigest(files)
  )
}
