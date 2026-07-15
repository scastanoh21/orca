import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_TUPLES = 8
const AGGREGATE_TIMEOUT_MS = 15 * 60_000
const ASSET_FIELDS = ['tupleId', 'name', 'contentId', 'sha256', 'size']

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime aggregate ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SSH relay runtime aggregate ${label} has unexpected or missing fields`)
  }
}

function expectedArchiveName(tupleId, contentId) {
  const digest = contentId.slice('sha256:'.length)
  const extension = tupleId.startsWith('win32-') ? 'zip' : 'tar.xz'
  return `orca-ssh-relay-runtime-v1-${tupleId}-${digest}.${extension}`
}

function normalizeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > MAX_TUPLES) {
    throw new Error('SSH relay runtime aggregate assets must be a bounded non-empty array')
  }
  const tupleIds = new Set()
  const names = new Set()
  return assets.map((asset, index) => {
    assertExactFields(asset, ASSET_FIELDS, `asset ${index}`)
    if (!Object.hasOwn(sshRelayRuntimeCompatibility, asset.tupleId)) {
      throw new Error(`SSH relay runtime aggregate has an unsupported tuple: ${asset.tupleId}`)
    }
    if (tupleIds.has(asset.tupleId)) {
      throw new Error(`SSH relay runtime aggregate has a duplicate tuple: ${asset.tupleId}`)
    }
    tupleIds.add(asset.tupleId)
    if (typeof asset.name !== 'string' || !ASSET_NAME_PATTERN.test(asset.name)) {
      throw new Error('SSH relay runtime aggregate asset has an invalid name')
    }
    if (names.has(asset.name)) {
      throw new Error(`SSH relay runtime aggregate has a duplicate asset: ${asset.name}`)
    }
    names.add(asset.name)
    if (!DIGEST_PATTERN.test(asset.contentId)) {
      throw new Error('SSH relay runtime aggregate asset has an invalid content identity')
    }
    if (!DIGEST_PATTERN.test(asset.sha256)) {
      throw new Error('SSH relay runtime aggregate asset has an invalid SHA-256')
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES) {
      throw new Error('SSH relay runtime aggregate asset has an invalid size')
    }
    if (asset.name !== expectedArchiveName(asset.tupleId, asset.contentId)) {
      throw new Error(`SSH relay runtime aggregate archive name is inconsistent: ${asset.name}`)
    }
    return { ...asset }
  })
}

function sameFileState(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

async function hashArchive(path, asset, signal) {
  signal?.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`SSH relay runtime aggregate input is not a regular file: ${asset.name}`)
  }
  if (before.size !== BigInt(asset.size)) {
    throw new Error(`SSH relay runtime aggregate input size mismatch: ${asset.name}`)
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted()
    bytes += chunk.length
    if (bytes > asset.size) {
      throw new Error(`SSH relay runtime aggregate input exceeded its size: ${asset.name}`)
    }
    hash.update(chunk)
  }
  const after = await lstat(path, { bigint: true })
  // Why: aggregate identity must describe one stable file, not bytes swapped during hashing.
  if (!sameFileState(before, after)) {
    throw new Error(`SSH relay runtime aggregate input changed while hashing: ${asset.name}`)
  }
  if (bytes !== asset.size) {
    throw new Error(`SSH relay runtime aggregate input size mismatch: ${asset.name}`)
  }
  const digest = `sha256:${hash.digest('hex')}`
  if (digest !== asset.sha256) {
    throw new Error(`SSH relay runtime aggregate input SHA-256 mismatch: ${asset.name}`)
  }
}

export async function verifySshRelayRuntimeAggregateInputs({ inputDirectory, assets, signal }) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(AGGREGATE_TIMEOUT_MS)])
    : AbortSignal.timeout(AGGREGATE_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  if (typeof inputDirectory !== 'string' || inputDirectory.length === 0) {
    throw new Error('SSH relay runtime aggregate input directory is required')
  }
  const normalized = normalizeAssets(assets)
  const root = resolve(inputDirectory)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('SSH relay runtime aggregate input root must be a real directory')
  }
  const entries = await readdir(root, { withFileTypes: true })
  const actualNames = entries.map((entry) => entry.name).sort()
  const expectedNames = normalized.map((asset) => asset.name).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('SSH relay runtime aggregate input directory has missing or unexpected files')
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`SSH relay runtime aggregate input is not a regular file: ${entry.name}`)
    }
  }
  for (const asset of normalized) {
    const path = join(root, asset.name)
    if (basename(path) !== asset.name) {
      throw new Error(`SSH relay runtime aggregate asset path is unsafe: ${asset.name}`)
    }
    await hashArchive(path, asset, effectiveSignal)
  }
  return normalized
}
