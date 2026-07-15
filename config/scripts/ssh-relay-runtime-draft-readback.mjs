import { createHash } from 'node:crypto'

const API_VERSION = '2022-11-28'
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-rc\.\d+(?:\.[0-9A-Za-z]+)?)?$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const MANAGED_ASSET_PREFIX = 'orca-ssh-relay-runtime-'
const RELEASE_ASSET_HOST = 'release-assets.githubusercontent.com'
const MAX_ASSET_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const MAX_ASSETS = 26
const READBACK_TIMEOUT_MS = 15 * 60_000
const ASSET_FIELDS = ['name', 'sha256', 'size']

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime draft read-back ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SSH relay runtime draft read-back ${label} has unexpected or missing fields`)
  }
}

function normalizeExpectedAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > MAX_ASSETS) {
    throw new Error('SSH relay runtime draft read-back assets must be a bounded non-empty array')
  }
  const names = new Set()
  let totalBytes = 0
  const normalized = assets.map((asset, index) => {
    assertExactFields(asset, ASSET_FIELDS, `expected asset ${index}`)
    if (
      typeof asset.name !== 'string' ||
      !ASSET_NAME_PATTERN.test(asset.name) ||
      !asset.name.startsWith(MANAGED_ASSET_PREFIX)
    ) {
      throw new Error('SSH relay runtime draft read-back expected an invalid managed asset')
    }
    if (names.has(asset.name)) {
      throw new Error(`SSH relay runtime draft read-back has a duplicate asset: ${asset.name}`)
    }
    names.add(asset.name)
    if (typeof asset.sha256 !== 'string' || !DIGEST_PATTERN.test(asset.sha256)) {
      throw new Error('SSH relay runtime draft read-back expected an invalid SHA-256')
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) {
      throw new Error('SSH relay runtime draft read-back expected an invalid size')
    }
    totalBytes += asset.size
    return { ...asset }
  })
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('SSH relay runtime draft read-back expected assets exceed the total size limit')
  }
  return normalized
}

function authenticatedHeaders(token, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION
  }
}

async function responseError(response) {
  const body = await response.text().catch(() => '')
  return new Error(
    `SSH relay runtime GitHub request failed ${response.status} ${response.statusText}: ${body.slice(0, 300)}`
  )
}

async function fetchRelease({ repo, releaseId, token, fetchImpl, signal }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/${releaseId}`, {
    headers: authenticatedHeaders(token),
    redirect: 'error',
    signal
  })
  if (!response.ok) {
    throw await responseError(response)
  }
  return response.json()
}

function validateRelease(release, releaseId, tag, expectedAssets) {
  assertObject(release, 'release')
  if (release.id !== releaseId || release.draft !== true) {
    throw new Error('SSH relay runtime release must remain the requested draft during read-back')
  }
  if (release.tag_name !== tag) {
    throw new Error('SSH relay runtime draft read-back tag does not match')
  }
  if (!Array.isArray(release.assets)) {
    throw new Error('SSH relay runtime draft read-back release assets must be an array')
  }
  const expectedByName = new Map(expectedAssets.map((asset) => [asset.name, asset]))
  const releaseByName = new Map()
  for (const asset of release.assets) {
    assertObject(asset, 'release asset')
    if (typeof asset.name !== 'string' || releaseByName.has(asset.name)) {
      throw new Error('SSH relay runtime draft read-back has a duplicate or invalid release asset')
    }
    releaseByName.set(asset.name, asset)
    if (asset.name.startsWith(MANAGED_ASSET_PREFIX) && !expectedByName.has(asset.name)) {
      throw new Error(`SSH relay runtime draft has an unexpected managed asset: ${asset.name}`)
    }
  }
  for (const expected of expectedAssets) {
    const actual = releaseByName.get(expected.name)
    if (!actual) {
      throw new Error(`SSH relay runtime draft is missing managed asset: ${expected.name}`)
    }
    if (!Number.isSafeInteger(actual.id) || actual.id <= 0) {
      throw new Error(`SSH relay runtime draft asset has an invalid ID: ${expected.name}`)
    }
    if (actual.state !== 'uploaded') {
      throw new Error(`SSH relay runtime draft asset is not uploaded: ${expected.name}`)
    }
    if (actual.size !== expected.size) {
      throw new Error(`SSH relay runtime draft asset size disagrees: ${expected.name}`)
    }
  }
  return releaseByName
}

function redirectedAssetUrl(response) {
  const location = response.headers.get('location')
  if (!location) {
    throw new Error('SSH relay runtime draft read-back redirect is missing Location')
  }
  const url = new URL(location)
  if (url.protocol !== 'https:') {
    throw new Error('SSH relay runtime draft read-back redirect must use HTTPS')
  }
  if (url.hostname !== RELEASE_ASSET_HOST) {
    throw new Error('SSH relay runtime draft read-back redirect has an unapproved origin')
  }
  return url.href
}

async function fetchAsset({ repo, assetId, token, fetchImpl, signal }) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/releases/assets/${assetId}`,
    {
      headers: authenticatedHeaders(token, 'application/octet-stream'),
      redirect: 'manual',
      signal
    }
  )
  if (response.status !== 302) {
    // Why: partial or otherwise unusual successful responses cannot prove the exact release asset.
    if (response.status !== 200) {
      throw await responseError(response)
    }
    return response
  }
  const location = redirectedAssetUrl(response)
  // Why: the API request is authenticated, but its signed CDN redirect must never receive the token.
  const redirected = await fetchImpl(location, {
    headers: { Accept: 'application/octet-stream' },
    redirect: 'error',
    signal
  })
  if (redirected.status !== 200) {
    throw await responseError(redirected)
  }
  return redirected
}

async function hashResponse(response, expected, signal) {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed !== expected.size) {
      throw new Error(
        `SSH relay runtime draft read-back Content-Length disagrees: ${expected.name}`
      )
    }
  }
  if (!response.body) {
    throw new Error(`SSH relay runtime draft read-back body is missing: ${expected.name}`)
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of response.body) {
    signal?.throwIfAborted()
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > expected.size || bytes > MAX_ASSET_BYTES) {
      throw new Error(`SSH relay runtime draft read-back size exceeded: ${expected.name}`)
    }
    hash.update(buffer)
  }
  if (bytes !== expected.size) {
    throw new Error(`SSH relay runtime draft read-back size mismatch: ${expected.name}`)
  }
  const digest = `sha256:${hash.digest('hex')}`
  if (digest !== expected.sha256) {
    throw new Error(`SSH relay runtime draft read-back SHA-256 mismatch: ${expected.name}`)
  }
}

export async function verifySshRelayRuntimeDraftReadback({
  repo,
  releaseId,
  tag,
  token,
  expectedAssets,
  fetchImpl = fetch,
  signal
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(READBACK_TIMEOUT_MS)])
    : AbortSignal.timeout(READBACK_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  if (typeof repo !== 'string' || !REPOSITORY_PATTERN.test(repo)) {
    throw new Error('SSH relay runtime draft read-back repository is invalid')
  }
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw new Error('SSH relay runtime draft read-back release ID is invalid')
  }
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new Error('SSH relay runtime draft read-back tag is invalid')
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('SSH relay runtime draft read-back token is required')
  }
  const expected = normalizeExpectedAssets(expectedAssets)
  const release = await fetchRelease({
    repo,
    releaseId,
    token,
    fetchImpl,
    signal: effectiveSignal
  })
  const releaseAssets = validateRelease(release, releaseId, tag, expected)
  for (const asset of expected) {
    effectiveSignal.throwIfAborted()
    const response = await fetchAsset({
      repo,
      assetId: releaseAssets.get(asset.name).id,
      token,
      fetchImpl,
      signal: effectiveSignal
    })
    await hashResponse(response, asset, effectiveSignal)
  }
  return { releaseId, tag, downloadedAssets: expected }
}
