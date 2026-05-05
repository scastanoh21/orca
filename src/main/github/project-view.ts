/* eslint-disable max-lines -- Why: ProjectV2 GraphQL has its own normalization
layer, retry policy (parent-field dance), paste-to-add parser, discovery
pagination, and slug-addressed mutation helpers. Co-locating them keeps the
retry/classify/normalize contract reviewable as one surface. Splitting would
risk drifting classification semantics between read and write paths. */
// Why: `ghExecFileAsync` (WSL-aware, retry-enabled) is the single spawn site
// for gh calls. The legacy plain `execFileAsync` is NOT used here — routing
// every gh call through the runner gives us transient-5xx retry, WSL path
// translation, and a single hook point for future quota tracking.
import { acquire, release } from './gh-utils'
import { extractExecError, ghExecFileAsync } from '../git/runner'
import { rateLimitGuard, noteRateLimitSpend, type RateLimitBucketKind } from './rate-limit'
import type { GitHubAssignableUser, GitHubWorkItemDetails, PRComment } from '../../shared/types'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  GetProjectViewTableResult,
  GitHubProjectCommentMutationResult,
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectFieldValue,
  GitHubProjectIteration,
  GitHubProjectLabel,
  GitHubProjectMutationResult,
  GitHubProjectOwnerType,
  GitHubProjectRow,
  GitHubProjectRowItemType,
  GitHubProjectSingleSelectOption,
  GitHubProjectSort,
  GitHubProjectSummary,
  GitHubProjectTable,
  GitHubProjectUser,
  GitHubProjectView,
  GitHubProjectViewError,
  GitHubProjectViewLayout,
  GitHubProjectViewSummary,
  ListAccessibleProjectsResult,
  ListAssignableUsersBySlugArgs,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugArgs,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugArgs,
  ListLabelsBySlugResult,
  ListProjectViewsArgs,
  ListProjectViewsResult,
  ProjectWorkItemDetailsBySlugArgs,
  ProjectWorkItemDetailsBySlugResult,
  ResolveProjectRefArgs,
  ResolveProjectRefResult,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdatePullRequestBySlugArgs,
  UpdateProjectItemFieldArgs
} from '../../shared/github-project-types'

// ─── Constants ─────────────────────────────────────────────────────────

// Why: these defaults were deliberately shrunk from 50/50/100 to cut quota
// spend in the most expensive gh call reachable from TaskPage. Discovery
// walks viewer projects, then up to `DISCOVERY_MAX_ORGS` orgs × a nested
// `projectsV2(first:N)` query. The org loop dominates the cost and is the
// path that produced the user-visible HTTP 504 when one org was slow. Users
// with projects outside this window can still paste a URL to reach them —
// no functional loss. Prior values: MAX_ORGS=50, ORG_PAGE_SIZE=30,
// PROJECTS_PER_OWNER=100, nested projectsV2 first=50.
const ITEM_PAGE_SIZE = 100
const MAX_ITEMS = 500
const VIEWS_PAGE_SIZE = 20
const FIELDS_PAGE_SIZE = 50
const DISCOVERY_PROJECTS_PER_OWNER = 40
const DISCOVERY_MAX_ORGS = 20
const DISCOVERY_ORG_PAGE_SIZE = 20
const DISCOVERY_PROJECTS_PER_ORG = 20
const FIELD_VALUES_PAGE_SIZE = 100

// ─── Module-scope caches (reset on HMR — intentional) ──────────────────

// Why: HMR reloading should re-probe capability. Both caches live as plain
// module locals so a dev-time code swap naturally re-runs capability probes
// instead of carrying a stale "unsupported" flag into fresh code.
const ownerTypeCache = new Map<string, GitHubProjectOwnerType | null>()
let parentFieldRetried = false
let parentFieldWarningLogged = false
// Why: concurrent fetchAllItems calls all observe parentFieldRetried=false,
// each issuing a duplicate first-page probe and racing to set the flag. Use
// an in-flight promise so only one caller drives the probe; siblings await
// the same result.
let parentFieldProbeInFlight: Promise<void> | null = null

/** @internal — test-only */
export function _resetProjectViewModuleState(): void {
  ownerTypeCache.clear()
  parentFieldRetried = false
  parentFieldWarningLogged = false
  parentFieldProbeInFlight = null
}

// ─── Slug validation ──────────────────────────────────────────────────

// Why: GitHub usernames/org logins disallow `_`, `.`, leading `-`. Repo names
// are looser — they allow leading `_`, `.`, `-` (`.` and `..` reserved). We
// validate each separately so untrusted Project row data (`nameWithOwner`)
// can't become an arbitrary REST path while still accepting realistic repo
// names like `_internal` or `.github`.
const OWNER_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+$/
const REPO_SLUG_RESERVED = new Set(['.', '..'])

export function isValidOwnerSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && OWNER_SLUG_RE.test(value)
}

export function isValidRepoSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    REPO_SLUG_RE.test(value) &&
    !REPO_SLUG_RESERVED.has(value)
  )
}

// Backwards-compatible alias for callers that don't distinguish owner vs repo.
// Prefer `isValidOwnerSlug` / `isValidRepoSlug` at new call sites.
export function isValidSlug(value: unknown): value is string {
  return isValidOwnerSlug(value) || isValidRepoSlug(value)
}

function assertSlug(
  value: unknown,
  field: 'owner' | 'repo'
): { ok: true; slug: string } | { ok: false; error: GitHubProjectViewError } {
  const valid = field === 'owner' ? isValidOwnerSlug(value) : isValidRepoSlug(value)
  if (!valid) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: `Invalid ${field}: "${String(value)}" is not a valid GitHub slug.`
      }
    }
  }
  return { ok: true, slug: value as string }
}

function assertPositiveInt(
  value: unknown,
  field: string
): { ok: true; n: number } | { ok: false; error: GitHubProjectViewError } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: `Invalid ${field}: must be a positive integer.`
      }
    }
  }
  return { ok: true, n: value }
}

// ─── Error classification ──────────────────────────────────────────────

type GhGraphqlErrorShape = {
  type?: string
  message?: string
  path?: Array<string | number>
  extensions?: { code?: string }
}

function extractGraphqlErrors(stderr: string, stdout: string): GhGraphqlErrorShape[] {
  // `gh api graphql` prints the response JSON to stdout even on GraphQL
  // errors, and the stderr carries a summary. Try stdout first; if parsing
  // fails, fall back to stderr.
  const sources = [stdout, stderr]
  for (const src of sources) {
    if (!src) continue
    try {
      const parsed = JSON.parse(src) as { errors?: GhGraphqlErrorShape[] }
      if (parsed.errors && parsed.errors.length > 0) {
        return parsed.errors
      }
    } catch {
      // not JSON — continue
    }
  }
  return []
}

function errorsIndicateParentField(errors: GhGraphqlErrorShape[], stderr: string): boolean {
  const lower = stderr.toLowerCase()
  // Preview-header shape: gh returns a 4xx with "preview" in the message.
  if (lower.includes('preview') && lower.includes('parent')) return true
  return errors.some((e) => {
    const type = (e.type ?? '').toUpperCase()
    if (type === 'FIELD_NOT_FOUND' || type === 'UNDEFINED_FIELD' || type === 'FIELD_ERRORS') {
      const tail = e.path?.[e.path.length - 1]
      if (tail === 'parent') return true
      // FIELD_ERRORS often omits `path`; match on message for the parent field.
      if ((e.message ?? '').toLowerCase().includes('parent')) return true
    }
    return false
  })
}

export function classifyProjectError(stderr: string, stdout: string): GitHubProjectViewError {
  const errors = extractGraphqlErrors(stderr, stdout)
  const s = stderr.toLowerCase()

  // Auth
  if (s.includes('authentication required') || s.includes('not logged in') || s.includes('gh auth login')) {
    return {
      type: 'auth_required',
      message: 'Sign in to GitHub to load project tasks. Run `gh auth login`.'
    }
  }
  // Scope
  if (
    s.includes('missing required scope') ||
    s.includes("your token has not been granted") ||
    (s.includes('resource not accessible') && (s.includes('project') || s.includes('scope')))
  ) {
    return {
      type: 'scope_missing',
      message:
        'GitHub project access needs additional scopes. Run `gh auth refresh -s project -s read:org -s repo`.'
    }
  }
  // Rate limit
  if (s.includes('rate limit') || s.includes('api rate limit exceeded')) {
    return { type: 'rate_limited', message: 'GitHub rate limit hit. Try again in a few minutes.' }
  }
  // Network — checked BEFORE not_found because DNS failures surface as
  // "could not resolve host", which would otherwise be partially matched by
  // the not_found branch's "could not resolve" check. Substring matching here
  // is a one-way trapdoor: a real GraphQL "Could not resolve to a User…"
  // error always contains "to a", so we tighten the not_found check below to
  // require that token.
  if (
    s.includes('timeout') ||
    s.includes('no such host') ||
    s.includes('network') ||
    s.includes('could not resolve host') ||
    s.includes('dial tcp')
  ) {
    return { type: 'network_error', message: 'Network error — check your connection.' }
  }
  // Not found
  if (
    s.includes('http 404') ||
    errors.some((e) => (e.type ?? '').toUpperCase() === 'NOT_FOUND') ||
    s.includes('could not resolve to a ')
  ) {
    const firstNotFound = errors.find((e) => (e.type ?? '').toUpperCase() === 'NOT_FOUND')
    return {
      type: 'not_found',
      message: 'Project or view not found.',
      details: firstNotFound
        ? { path: firstNotFound.path, code: firstNotFound.extensions?.code }
        : undefined
    }
  }
  // Validation
  if (s.includes('http 422') || s.includes('validation failed')) {
    return { type: 'validation_error', message: `Invalid request — ${stderr.trim()}` }
  }
  // GraphQL error with structured info
  if (errors.length > 0) {
    const first = errors[0]
    return {
      type: 'unknown',
      message: first.message ?? 'Unknown GraphQL error.',
      details: { path: first.path, code: first.extensions?.code }
    }
  }
  return { type: 'unknown', message: `GitHub request failed: ${stderr.trim()}` }
}

function driftError(
  reason: string,
  details?: { path?: Array<string | number>; code?: string }
): GitHubProjectViewError {
  return { type: 'schema_drift', message: `Could not read this project view: ${reason}.`, details }
}

// Why: the rate-limit circuit breaker short-circuits before we spawn `gh`
// when the cached snapshot says we're below the safety floor. Synthesize the
// same `rate_limited` error shape as the post-hoc classifier so the UI path
// is unchanged. We DO NOT fail open here when there's no cached snapshot —
// rateLimitGuard already handles that case (returns `blocked:false`).
function rateLimitedError(
  blocked: { remaining: number; limit: number; resetAt: number }
): GitHubProjectViewError {
  const resetIn = Math.max(0, blocked.resetAt - Math.floor(Date.now() / 1000))
  const mins = Math.ceil(resetIn / 60)
  return {
    type: 'rate_limited',
    message: `GitHub rate limit nearly exhausted (${blocked.remaining}/${blocked.limit} left). Resets in ~${mins}m.`
  }
}

// ─── Low-level gh api graphql invocation ───────────────────────────────

type GraphqlVars = Record<string, string | number | boolean>

async function runGraphql<T>(
  query: string,
  vars: GraphqlVars,
  cwd?: string
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: GitHubProjectViewError; raw: { stderr: string; stdout: string } }
> {
  const guard = rateLimitGuard('graphql')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard), raw: { stderr: '', stdout: '' } }
  }
  // Why: build argv as an array. `-f` for strings (including numbers passed
  // as strings), `-F` coerces to typed. We use `-f` uniformly and coerce in
  // the query via Int! casts, because `gh` can confuse empty strings.
  const args: string[] = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'number' || typeof v === 'boolean') {
      args.push('-F', `${k}=${String(v)}`)
    } else {
      args.push('-f', `${k}=${v}`)
    }
  }
  await acquire()
  noteRateLimitSpend('graphql')
  try {
    const { stdout, stderr } = await ghExecFileAsync(args, {
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {})
    })
    try {
      const parsed = JSON.parse(stdout) as { data?: T; errors?: GhGraphqlErrorShape[] }
      if (parsed.errors && parsed.errors.length > 0) {
        return {
          ok: false,
          error: classifyProjectError(stderr, stdout),
          raw: { stderr, stdout }
        }
      }
      if (parsed.data === undefined) {
        return {
          ok: false,
          error: driftError('response missing data'),
          raw: { stderr, stdout }
        }
      }
      return { ok: true, data: parsed.data }
    } catch (parseErr) {
      return {
        ok: false,
        error: driftError(
          `failed to parse response (${parseErr instanceof Error ? parseErr.message : String(parseErr)})`
        ),
        raw: { stderr, stdout }
      }
    }
  } catch (err) {
    // gh executable failures (non-zero exit). Read stderr/stdout from the
    // exec rejection's explicit fields — `err.message` may truncate stderr.
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return {
      ok: false,
      error: classifyProjectError(stderr, maybeStdout),
      raw: { stderr, stdout: maybeStdout }
    }
  } finally {
    release()
  }
}

async function runRest<T>(
  args: string[],
  cwd?: string,
  bucket: RateLimitBucketKind = 'core',
  options?: { expectEmpty?: boolean }
): Promise<{ ok: true; data: T } | { ok: false; error: GitHubProjectViewError }> {
  const guard = rateLimitGuard(bucket)
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  await acquire()
  noteRateLimitSpend(bucket)
  try {
    const { stdout, stderr } = await ghExecFileAsync(['api', ...args], {
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {})
    })
    // Why: 204/empty-body endpoints (DELETE label, DELETE comment) return no
    // body. Treat empty stdout as success rather than misclassifying the
    // unparseable response as 'unknown' — which the caller would otherwise
    // need to special-case and risks masking real failures whose stderr the
    // classifier also tags as 'unknown'.
    if (options?.expectEmpty && stdout.trim() === '') {
      return { ok: true, data: undefined as T }
    }
    try {
      return { ok: true, data: JSON.parse(stdout) as T }
    } catch {
      return {
        ok: false,
        error: { type: 'unknown', message: `Unexpected REST response: ${stderr.trim()}` }
      }
    }
  } catch (err) {
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, maybeStdout) }
  } finally {
    release()
  }
}

// ─── Normalizers ───────────────────────────────────────────────────────

type RawProjectV2Field = {
  __typename?: string
  id?: string
  name?: string
  dataType?: string
  options?: Array<{ id?: string; name?: string; color?: string }>
  configuration?: {
    iterations?: Array<{ id?: string; title?: string; startDate?: string; duration?: number }>
    completedIterations?: Array<{
      id?: string
      title?: string
      startDate?: string
      duration?: number
    }>
  }
}

export function normalizeField(raw: RawProjectV2Field | null | undefined): GitHubProjectField | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null
  }
  const dataType = raw.dataType ?? raw.__typename ?? ''
  if (raw.__typename === 'ProjectV2SingleSelectField' || dataType === 'SINGLE_SELECT') {
    const options: GitHubProjectSingleSelectOption[] = (raw.options ?? [])
      .map((o) =>
        typeof o.id === 'string' && typeof o.name === 'string'
          ? { id: o.id, name: o.name, color: o.color ?? '' }
          : null
      )
      .filter((o): o is GitHubProjectSingleSelectOption => o !== null)
    return { kind: 'single-select', id: raw.id, name: raw.name, dataType: 'SINGLE_SELECT', options }
  }
  if (raw.__typename === 'ProjectV2IterationField' || dataType === 'ITERATION') {
    const cfg = raw.configuration ?? {}
    const iterations: GitHubProjectIteration[] = []
    for (const it of cfg.completedIterations ?? []) {
      if (typeof it.id === 'string' && typeof it.title === 'string') {
        iterations.push({
          id: it.id,
          title: it.title,
          startDate: it.startDate ?? '',
          duration: typeof it.duration === 'number' ? it.duration : 0,
          completed: true
        })
      }
    }
    for (const it of cfg.iterations ?? []) {
      if (typeof it.id === 'string' && typeof it.title === 'string') {
        iterations.push({
          id: it.id,
          title: it.title,
          startDate: it.startDate ?? '',
          duration: typeof it.duration === 'number' ? it.duration : 0,
          completed: false
        })
      }
    }
    return { kind: 'iteration', id: raw.id, name: raw.name, dataType: 'ITERATION', iterations }
  }
  return { kind: 'field', id: raw.id, name: raw.name, dataType }
}

type RawUser = {
  login?: string
  name?: string | null
  avatarUrl?: string | null
}

function normalizeUser(raw: RawUser | null | undefined): GitHubProjectUser | null {
  if (!raw || typeof raw.login !== 'string') return null
  return {
    login: raw.login,
    name: raw.name ?? null,
    avatarUrl: raw.avatarUrl ?? null
  }
}

type RawLabel = { name?: string; color?: string }

function normalizeLabel(raw: RawLabel | null | undefined): GitHubProjectLabel | null {
  if (!raw || typeof raw.name !== 'string') return null
  return { name: raw.name, color: raw.color ?? '' }
}

type RawFieldValue = {
  __typename?: string
  field?: RawProjectV2Field
  name?: string
  color?: string
  optionId?: string
  title?: string
  startDate?: string
  duration?: number
  iterationId?: string
  text?: string
  number?: number
  date?: string
  labels?: { nodes?: RawLabel[] }
  users?: { nodes?: RawUser[] }
}

export function normalizeFieldValue(raw: RawFieldValue | null | undefined): GitHubProjectFieldValue | null {
  if (!raw || !raw.field || typeof raw.field.id !== 'string') return null
  const fieldId = raw.field.id
  switch (raw.__typename) {
    case 'ProjectV2ItemFieldSingleSelectValue':
      if (typeof raw.optionId !== 'string') return null
      return {
        kind: 'single-select',
        fieldId,
        optionId: raw.optionId,
        name: raw.name ?? '',
        color: raw.color ?? ''
      }
    case 'ProjectV2ItemFieldIterationValue':
      if (typeof raw.iterationId !== 'string') return null
      return {
        kind: 'iteration',
        fieldId,
        iterationId: raw.iterationId,
        title: raw.title ?? '',
        startDate: raw.startDate ?? '',
        duration: typeof raw.duration === 'number' ? raw.duration : 0
      }
    case 'ProjectV2ItemFieldTextValue':
      return { kind: 'text', fieldId, text: raw.text ?? '' }
    case 'ProjectV2ItemFieldNumberValue':
      if (typeof raw.number !== 'number') return null
      return { kind: 'number', fieldId, number: raw.number }
    case 'ProjectV2ItemFieldDateValue':
      return { kind: 'date', fieldId, date: raw.date ?? '' }
    case 'ProjectV2ItemFieldLabelValue': {
      const labels = (raw.labels?.nodes ?? [])
        .map(normalizeLabel)
        .filter((l): l is GitHubProjectLabel => l !== null)
      return { kind: 'labels', fieldId, labels }
    }
    case 'ProjectV2ItemFieldUserValue': {
      const users = (raw.users?.nodes ?? [])
        .map(normalizeUser)
        .filter((u): u is GitHubProjectUser => u !== null)
      return { kind: 'users', fieldId, users }
    }
    default:
      // Unknown __typename → forward-compat: drop silently, do not throw,
      // do not classify as drift (see design §Error Handling).
      return null
  }
}

type RawContent = {
  __typename?: string
  id?: string
  number?: number
  title?: string
  body?: string
  url?: string
  state?: string
  stateReason?: string | null
  isDraft?: boolean
  repository?: { nameWithOwner?: string }
  assignees?: { nodes?: RawUser[] }
  labels?: { nodes?: RawLabel[] }
  parent?: { number?: number; title?: string; url?: string } | null
  issueType?: { id?: string; name?: string; color?: string | null; description?: string | null } | null
}

type RawItem = {
  id?: string
  type?: string
  updatedAt?: string
  content?: RawContent | null
  fieldValues?: {
    nodes?: RawFieldValue[]
    pageInfo?: { hasNextPage?: boolean }
  }
}

type NormalizedItemOutcome =
  | { ok: true; row: GitHubProjectRow }
  | { ok: false; drift: GitHubProjectViewError }

function mapItemType(raw: string | undefined, hasContent: boolean): GitHubProjectRowItemType {
  if (raw === 'ISSUE') return 'ISSUE'
  if (raw === 'PULL_REQUEST') return 'PULL_REQUEST'
  if (raw === 'DRAFT_ISSUE') return 'DRAFT_ISSUE'
  if (raw === 'REDACTED' || !hasContent) return 'REDACTED'
  // Unknown item type with content — treat as redacted rather than dropping.
  return 'REDACTED'
}

export function normalizeItem(raw: RawItem, position: number): NormalizedItemOutcome {
  if (!raw || typeof raw.id !== 'string') {
    return {
      ok: false,
      drift: driftError('item missing id', { path: ['items', 'nodes', position, 'id'] })
    }
  }
  if (raw.fieldValues?.pageInfo?.hasNextPage === true) {
    return {
      ok: false,
      drift: driftError('item field values exceeded single page', {
        path: ['items', 'nodes', position, 'fieldValues', 'pageInfo', 'hasNextPage']
      })
    }
  }
  const itemType = mapItemType(raw.type, raw.content !== null && raw.content !== undefined)
  const content = raw.content ?? null
  const assignees = (content?.assignees?.nodes ?? [])
    .map(normalizeUser)
    .filter((u): u is GitHubProjectUser => u !== null)
  const labels = (content?.labels?.nodes ?? [])
    .map(normalizeLabel)
    .filter((l): l is GitHubProjectLabel => l !== null)
  const parentIssue =
    content?.parent &&
    typeof content.parent.number === 'number' &&
    typeof content.parent.title === 'string' &&
    typeof content.parent.url === 'string'
      ? { number: content.parent.number, title: content.parent.title, url: content.parent.url }
      : null
  const issueType =
    content?.issueType &&
    typeof content.issueType.id === 'string' &&
    typeof content.issueType.name === 'string'
      ? {
          id: content.issueType.id,
          name: content.issueType.name,
          color: typeof content.issueType.color === 'string' ? content.issueType.color : null,
          description:
            typeof content.issueType.description === 'string' ? content.issueType.description : null
        }
      : null
  const fieldValuesByFieldId: Record<string, GitHubProjectFieldValue> = {}
  for (const fv of raw.fieldValues?.nodes ?? []) {
    const normalized = normalizeFieldValue(fv)
    if (normalized) {
      fieldValuesByFieldId[normalized.fieldId] = normalized
    }
  }
  const title =
    itemType === 'REDACTED'
      ? 'Restricted item'
      : typeof content?.title === 'string'
        ? content.title
        : ''
  const row: GitHubProjectRow = {
    id: raw.id,
    itemType,
    content: {
      number: typeof content?.number === 'number' ? content.number : null,
      title,
      body: typeof content?.body === 'string' ? content.body : null,
      url: typeof content?.url === 'string' ? content.url : null,
      state: typeof content?.state === 'string' ? content.state : null,
      stateReason: typeof content?.stateReason === 'string' ? content.stateReason : null,
      isDraft: typeof content?.isDraft === 'boolean' ? content.isDraft : null,
      repository:
        typeof content?.repository?.nameWithOwner === 'string'
          ? content.repository.nameWithOwner
          : null,
      assignees,
      labels,
      parentIssue,
      issueType
    },
    fieldValuesByFieldId,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    position
  }
  return { ok: true, row }
}

// ─── GraphQL query fragments ───────────────────────────────────────────

const FIELD_CONFIG_FRAGMENT = `
fragment FieldConfig on ProjectV2FieldConfiguration {
  __typename
  ... on ProjectV2Field { id name dataType }
  ... on ProjectV2SingleSelectField {
    id
    name
    dataType
    options { id name color }
  }
  ... on ProjectV2IterationField {
    id
    name
    dataType
    configuration {
      iterations { id title startDate duration }
      completedIterations { id title startDate duration }
    }
  }
}
`

function itemContentSelection(includeParent: boolean): string {
  const parentFrag = includeParent ? 'parent { number title url }' : ''
  return `
    __typename
    ... on Issue {
      id
      number
      title
      url
      state
      stateReason
      repository { nameWithOwner }
      assignees(first:5) { nodes { login name avatarUrl } }
      labels(first:10) { nodes { name color } }
      issueType { id name color description }
      ${parentFrag}
    }
    ... on PullRequest {
      id
      number
      title
      url
      state
      isDraft
      repository { nameWithOwner }
      assignees(first:5) { nodes { login name avatarUrl } }
      labels(first:10) { nodes { name color } }
    }
    ... on DraftIssue { id title body }
  `
}

const FIELD_VALUES_SELECTION = `
  fieldValues(first:${FIELD_VALUES_PAGE_SIZE}) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { field { ...FieldConfig } name color optionId }
      ... on ProjectV2ItemFieldIterationValue    { field { ...FieldConfig } title startDate duration iterationId }
      ... on ProjectV2ItemFieldTextValue         { field { ...FieldConfig } text }
      ... on ProjectV2ItemFieldNumberValue       { field { ...FieldConfig } number }
      ... on ProjectV2ItemFieldDateValue         { field { ...FieldConfig } date }
      ... on ProjectV2ItemFieldLabelValue        { field { ...FieldConfig } labels(first:10) { nodes { name color } } }
      ... on ProjectV2ItemFieldUserValue         { field { ...FieldConfig } users(first:5) { nodes { login name avatarUrl } } }
    }
  }
`

// ─── Project config fetch (views + fields, paginated) ──────────────────

type RawProjectConfig = {
  id?: string
  title?: string
  url?: string
  views?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    nodes?: Array<RawProjectView | null>
  }
}

type RawProjectView = {
  id?: string
  number?: number
  name?: string
  layout?: string
  filter?: string | null
  fields?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    nodes?: Array<RawProjectV2Field | null>
  }
  groupByFields?: { nodes?: Array<RawProjectV2Field | null> }
  sortByFields?: {
    nodes?: Array<{ direction?: string; field?: RawProjectV2Field | null } | null>
  }
}

function ownerQueryRoot(ownerType: GitHubProjectOwnerType): string {
  return ownerType === 'organization' ? 'organization' : 'user'
}

async function fetchProjectViewsPage(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  after: string | null
}): Promise<
  | {
      ok: true
      project: { id: string; title: string; url: string }
      views: RawProjectView[]
      hasNextPage: boolean
      endCursor: string | null
    }
  | { ok: false; error: GitHubProjectViewError }
> {
  const root = ownerQueryRoot(args.ownerType)
  const afterArg = args.after ? `, after: $after` : ''
  const afterVar = args.after ? `$after:String!, ` : ''
  const query = `
    query(${afterVar}$owner:String!, $num:Int!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          id title url
          views(first:${VIEWS_PAGE_SIZE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id number name layout filter
              fields(first:${FIELDS_PAGE_SIZE}) {
                pageInfo { hasNextPage endCursor }
                nodes { ...FieldConfig }
              }
              groupByFields(first:10) { nodes { ...FieldConfig } }
              sortByFields(first:10) {
                nodes { direction field { ...FieldConfig } }
              }
            }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const vars: GraphqlVars = { owner: args.owner, num: args.projectNumber }
  if (args.after) vars.after = args.after
  const res = await runGraphql<Record<string, { projectV2?: RawProjectConfig | null } | null>>(
    query,
    vars
  )
  if (!res.ok) return res
  const top = res.data[root]
  const project = top?.projectV2 ?? null
  if (!project || typeof project.id !== 'string') {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  const pageInfo = project.views?.pageInfo
  const views = (project.views?.nodes ?? []).filter((v): v is RawProjectView => v !== null)
  return {
    ok: true,
    project: { id: project.id, title: project.title ?? '', url: project.url ?? '' },
    views,
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor ?? null
  }
}

async function fetchViewFieldsContinuation(
  viewId: string,
  after: string
): Promise<{ ok: true; fields: RawProjectV2Field[] } | { ok: false; error: GitHubProjectViewError }> {
  // Why: address the view directly via `node(id:)` instead of re-fetching the
  // whole project + walking views every page. Previous shape paid an
  // unnecessary `${VIEWS_PAGE_SIZE}` views fan-out per field-continuation
  // page; the new shape is one round-trip per field page, which is the
  // minimum possible cost. Field-paged views are rare (>50 fields), so this
  // only matters for the few projects that hit it — but when they do, the
  // savings compound across pagination loops.
  const query = `
    query($after:String!, $viewId:ID!) {
      node(id:$viewId) {
        ... on ProjectV2View {
          id
          fields(first:${FIELDS_PAGE_SIZE}, after:$after) {
            pageInfo { hasNextPage endCursor }
            nodes { ...FieldConfig }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const collected: RawProjectV2Field[] = []
  let cursor: string | null = after
  while (cursor !== null) {
    const res = await runGraphql<{
      node?: {
        id?: string
        fields?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: Array<RawProjectV2Field | null>
        }
      } | null
    }>(query, { viewId, after: cursor })
    if (!res.ok) return res
    const view = res.data.node ?? null
    if (!view) {
      return { ok: false, error: driftError('view disappeared during field pagination') }
    }
    const nodes = (view.fields?.nodes ?? []).filter(
      (f): f is RawProjectV2Field => f !== null
    )
    collected.push(...nodes)
    const pi = view.fields?.pageInfo
    cursor = pi?.hasNextPage === true && typeof pi.endCursor === 'string' ? pi.endCursor : null
  }
  return { ok: true, fields: collected }
}

function finalizeView(
  raw: RawProjectView,
  extraFields: RawProjectV2Field[]
): { ok: true; view: GitHubProjectView } | { ok: false; drift: GitHubProjectViewError } {
  if (typeof raw.id !== 'string' || typeof raw.layout !== 'string') {
    return { ok: false, drift: driftError('view missing id or layout') }
  }
  const layout = raw.layout as GitHubProjectViewLayout
  const fields: GitHubProjectField[] = []
  const all = [...(raw.fields?.nodes ?? []), ...extraFields.map((f) => f as RawProjectV2Field)]
  for (const f of all) {
    const n = normalizeField(f)
    if (n) fields.push(n)
  }
  const groupByFields: GitHubProjectField[] = []
  for (const f of raw.groupByFields?.nodes ?? []) {
    const n = normalizeField(f)
    if (n) groupByFields.push(n)
  }
  const sortByFields: GitHubProjectSort[] = []
  for (const s of raw.sortByFields?.nodes ?? []) {
    if (!s || (s.direction !== 'ASC' && s.direction !== 'DESC')) continue
    const n = normalizeField(s.field)
    if (n) sortByFields.push({ direction: s.direction, field: n })
  }
  return {
    ok: true,
    view: {
      id: raw.id,
      number: typeof raw.number === 'number' ? raw.number : 0,
      name: typeof raw.name === 'string' ? raw.name : '',
      layout,
      // Why: `ProjectV2View.filter` is nullable — normalize to ''.
      filter: typeof raw.filter === 'string' ? raw.filter : '',
      fields,
      groupByFields,
      sortByFields
    }
  }
}

// ─── View selection ───────────────────────────────────────────────────

function matchesSelector(
  raw: RawProjectView,
  sel: { viewId?: string; viewNumber?: number; viewName?: string }
): 'none' | 'id' | 'number' | 'name' | 'default' {
  if (sel.viewId && raw.id === sel.viewId) return 'id'
  if (sel.viewNumber !== undefined && raw.number === sel.viewNumber) return 'number'
  if (sel.viewName && raw.name === sel.viewName) return 'name'
  if (
    sel.viewId === undefined &&
    sel.viewNumber === undefined &&
    sel.viewName === undefined &&
    raw.layout === 'TABLE_LAYOUT'
  ) {
    return 'default'
  }
  return 'none'
}

// ─── Items fetch (paginated) ──────────────────────────────────────────

type RawItemsPage = {
  totalCount?: number
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  nodes?: Array<RawItem | null>
}

// Why: runGraphql returns the classified error but not the raw GraphQL
// errors; for the parent-field retry decision we need those. This variant
// returns the raw envelope so callers can re-inspect.
async function fetchItemsPageWithRaw(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  first: number
  after: string | null
  includeParent: boolean
}): Promise<
  | { ok: true; page: RawItemsPage }
  | {
      ok: false
      error: GitHubProjectViewError
      rawErrors: GhGraphqlErrorShape[]
      stderr: string
    }
> {
  const root = ownerQueryRoot(args.ownerType)
  const afterArg = args.after ? `, after: $after` : ''
  const afterVar = args.after ? `$after:String!, ` : ''
  const query = `
    query(${afterVar}$owner:String!, $num:Int!, $q:String!, $first:Int!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          items(first:$first${afterArg}, query:$q, orderBy:{ field: POSITION, direction: ASC }) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              type
              updatedAt
              content { ${itemContentSelection(args.includeParent)} }
              ${FIELD_VALUES_SELECTION}
            }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const argsArr: string[] = ['api', 'graphql', '-f', `query=${query}`]
  argsArr.push('-f', `owner=${args.owner}`)
  argsArr.push('-F', `num=${args.projectNumber}`)
  argsArr.push('-f', `q=${args.query}`)
  argsArr.push('-F', `first=${args.first}`)
  if (args.after) argsArr.push('-f', `after=${args.after}`)

  const guard = rateLimitGuard('graphql')
  if (guard.blocked) {
    return {
      ok: false,
      error: rateLimitedError(guard),
      rawErrors: [],
      stderr: ''
    }
  }
  await acquire()
  noteRateLimitSpend('graphql')
  try {
    let stdout = ''
    let stderr = ''
    let execFailed = false
    try {
      const r = await ghExecFileAsync(argsArr, { encoding: 'utf-8' })
      stdout = r.stdout
      stderr = r.stderr
    } catch (err) {
      const extracted = extractExecError(err)
      stderr = extracted.stderr
      stdout = extracted.stdout
      execFailed = true
    }
    let parsed: { data?: Record<string, unknown>; errors?: GhGraphqlErrorShape[] } = {}
    try {
      parsed = JSON.parse(stdout)
    } catch {
      // Why: when gh exits non-zero with no parseable JSON on stdout (network,
      // auth, rate-limit, missing scope), classify against stderr so callers
      // see the real cause instead of a synthesized drift/not-found.
      if (execFailed) {
        return {
          ok: false,
          error: classifyProjectError(stderr, stdout),
          rawErrors: [],
          stderr
        }
      }
      return {
        ok: false,
        error: driftError('failed to parse items response'),
        rawErrors: [],
        stderr
      }
    }
    // Why: gh exec rejected but stdout still had a parseable error envelope —
    // fall through to the parsed.errors branch below. If parsed has neither
    // data nor errors, surface the stderr classification rather than not_found.
    if (execFailed && (!parsed.errors || parsed.errors.length === 0) && !parsed.data) {
      return {
        ok: false,
        error: classifyProjectError(stderr, stdout),
        rawErrors: [],
        stderr
      }
    }
    if (parsed.errors && parsed.errors.length > 0) {
      return {
        ok: false,
        error: classifyProjectError(stderr, stdout),
        rawErrors: parsed.errors,
        stderr
      }
    }
    const top = parsed.data?.[root] as { projectV2?: { items?: RawItemsPage } | null } | undefined
    const page = top?.projectV2?.items
    if (!page) {
      return {
        ok: false,
        error: { type: 'not_found', message: 'Project or view not found.' },
        rawErrors: [],
        stderr
      }
    }
    return { ok: true, page }
  } finally {
    release()
  }
}

async function fetchAllItems(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
}): Promise<
  | { ok: true; rows: GitHubProjectRow[]; totalCount: number; parentFieldDropped: boolean }
  | { ok: false; error: GitHubProjectViewError; totalCount?: number }
> {
  // Why: if another caller is currently probing whether Issue.parent is
  // supported, await its decision so we don't fire a duplicate with-parent
  // probe and don't capture a stale includeParent.
  if (parentFieldProbeInFlight) {
    await parentFieldProbeInFlight.catch(() => {})
  }
  let includeParent = !parentFieldRetried
  let parentFieldDropped = parentFieldRetried
  // First page — single-flight the with-parent attempt so concurrent callers
  // observe one probe result instead of each issuing their own.
  let first: Awaited<ReturnType<typeof fetchItemsPageWithRaw>>
  if (includeParent && !parentFieldProbeInFlight) {
    let resolveProbe: () => void = () => {}
    parentFieldProbeInFlight = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    try {
      first = await fetchItemsPageWithRaw({
        owner: args.owner,
        ownerType: args.ownerType,
        projectNumber: args.projectNumber,
        query: args.query,
        first: ITEM_PAGE_SIZE,
        after: null,
        includeParent: true
      })
    } finally {
      resolveProbe()
      parentFieldProbeInFlight = null
    }
  } else {
    first = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent
    })
  }
  if (!first.ok && includeParent && errorsIndicateParentField(first.rawErrors, first.stderr)) {
    // Retry the whole table without parent. Set module flag so the rest of
    // the process never re-probes until HMR or restart.
    parentFieldRetried = true
    includeParent = false
    parentFieldDropped = true
    if (!parentFieldWarningLogged) {
      console.warn(
        '[project-view] Issue.parent is not available on this token — retrying without the parent selection.'
      )
      parentFieldWarningLogged = true
    }
    first = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent: false
    })
  }
  if (!first.ok) return { ok: false, error: first.error }

  // Drift guards
  if (first.page.totalCount === undefined || first.page.totalCount === null) {
    return { ok: false, error: driftError('items.totalCount missing') }
  }
  const totalCount = first.page.totalCount
  if (first.page.pageInfo?.hasNextPage === undefined) {
    return { ok: false, error: driftError('items.pageInfo.hasNextPage missing'), totalCount }
  }
  if (!Array.isArray(first.page.nodes)) {
    return { ok: false, error: driftError('items.nodes missing'), totalCount }
  }

  // Size cap
  if (totalCount > MAX_ITEMS) {
    return { ok: false, error: { type: 'too_large', message: `View has ${totalCount} items.` }, totalCount }
  }

  const rows: GitHubProjectRow[] = []
  let position = 0
  const appendNodes = (nodes: Array<RawItem | null>): GitHubProjectViewError | null => {
    for (const n of nodes) {
      if (!n) continue
      const norm = normalizeItem(n, position)
      if (!norm.ok) return norm.drift
      rows.push(norm.row)
      position++
    }
    return null
  }
  const e1 = appendNodes(first.page.nodes)
  if (e1) return { ok: false, error: e1, totalCount }

  // Paginate
  let hasNext = first.page.pageInfo.hasNextPage === true
  let cursor: string | null | undefined = first.page.pageInfo.endCursor
  if (hasNext && typeof cursor !== 'string') {
    return {
      ok: false,
      error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
      totalCount
    }
  }
  while (hasNext) {
    const next = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: cursor as string,
      includeParent
    })
    if (!next.ok) return { ok: false, error: next.error, totalCount }
    if (!Array.isArray(next.page.nodes)) {
      return { ok: false, error: driftError('items.nodes missing on follow page'), totalCount }
    }
    if (next.page.pageInfo?.hasNextPage === undefined) {
      return {
        ok: false,
        error: driftError('items.pageInfo.hasNextPage missing on follow page'),
        totalCount
      }
    }
    const e2 = appendNodes(next.page.nodes)
    if (e2) return { ok: false, error: e2, totalCount }
    hasNext = next.page.pageInfo.hasNextPage === true
    cursor = next.page.pageInfo.endCursor
    if (hasNext && typeof cursor !== 'string') {
      return {
        ok: false,
        error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
        totalCount
      }
    }
  }
  return { ok: true, rows, totalCount, parentFieldDropped }
}

// ─── Cheap count-only query (for unsupported_layout) ──────────────────

async function fetchItemsCountOnly(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
}): Promise<number | null> {
  const root = ownerQueryRoot(args.ownerType)
  const query = `
    query($owner:String!, $num:Int!, $q:String!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          items(first:1, query:$q) { totalCount }
        }
      }
    }
  `
  const res = await runGraphql<
    Record<string, { projectV2?: { items?: { totalCount?: number } | null } | null } | null>
  >(query, { owner: args.owner, num: args.projectNumber, q: args.query })
  if (!res.ok) return null
  const count = res.data[root]?.projectV2?.items?.totalCount
  return typeof count === 'number' ? count : null
}

// ─── Public: getProjectViewTable ──────────────────────────────────────

export async function getProjectViewTable(
  args: GetProjectViewTableArgs
): Promise<GetProjectViewTableResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) return { ok: false, error: ownerCheck.error }
  const numCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numCheck.ok) return { ok: false, error: numCheck.error }
  if (args.ownerType !== 'organization' && args.ownerType !== 'user') {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'Invalid ownerType.' }
    }
  }

  // Paginate views until a match is found.
  let cursor: string | null = null
  let project: { id: string; title: string; url: string } | null = null
  let selectedRaw: RawProjectView | null = null
  let matchStrength: 'id' | 'number' | 'name' | 'default' | null = null
  const viewsSeen: RawProjectView[] = []
  while (true) {
    const page = await fetchProjectViewsPage({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      after: cursor
    })
    if (!page.ok) return { ok: false, error: page.error }
    project = page.project
    for (const v of page.views) {
      viewsSeen.push(v)
      const m = matchesSelector(v, {
        viewId: args.viewId,
        viewNumber: args.viewNumber,
        viewName: args.viewName
      })
      if (m === 'none') continue
      // Precedence: id > number > name > default.
      const rank: Record<typeof m, number> = { id: 4, number: 3, name: 2, default: 1 }
      const currentRank = matchStrength ? rank[matchStrength] : 0
      if (!selectedRaw || rank[m] > currentRank) {
        selectedRaw = v
        matchStrength = m
      }
    }
    // Why: stop as soon as we have ANY match — including 'default' (first
    // table view). Continuing to walk views pages for a default selector
    // costs one extra GraphQL call per page with no upside: the default
    // contract is "first table view we see", and view layouts don't change
    // ordering between pages such that a later view would outrank the
    // first table layout. Previously we kept walking on default match
    // because the precedence comment hinted at re-ranking, but no real
    // selector promotes a 'default' to a stronger match within the same
    // selector input — those ranks only matter when the caller supplied
    // a selector. Bail early on any non-null selectedRaw.
    if (selectedRaw) break
    if (!page.hasNextPage) break
    cursor = page.endCursor
    if (typeof cursor !== 'string') break
  }
  if (!project) {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  if (!selectedRaw) {
    return { ok: false, error: { type: 'not_found', message: 'Could not find the selected view.' } }
  }

  // Paginate view fields if necessary.
  let extraFields: RawProjectV2Field[] = []
  const fieldsPi = selectedRaw.fields?.pageInfo
  if (fieldsPi?.hasNextPage === true && typeof fieldsPi.endCursor === 'string' && selectedRaw.id) {
    const cont = await fetchViewFieldsContinuation(selectedRaw.id, fieldsPi.endCursor)
    if (!cont.ok) return { ok: false, error: cont.error }
    extraFields = cont.fields
  }

  const finalized = finalizeView(selectedRaw, extraFields)
  if (!finalized.ok) return { ok: false, error: finalized.drift }
  const selectedView = finalized.view

  // Why: an explicit empty-string override means "no filter"; treat undefined
  // as "use the view's filter as-is". The override is ephemeral — never
  // persisted to GitHub — so users can clear the search without mutating the
  // view's stored filter.
  const effectiveQuery =
    typeof args.queryOverride === 'string' ? args.queryOverride : selectedView.filter

  // Unsupported layout: return without paginating items; attempt a cheap
  // count-only query best-effort.
  if (selectedView.layout !== 'TABLE_LAYOUT') {
    const count = await fetchItemsCountOnly({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: effectiveQuery
    })
    return {
      ok: false,
      error: {
        type: 'unsupported_layout',
        message: `Orca only renders table views. This is a ${selectedView.layout.replace('_LAYOUT', '').toLowerCase()} view.`
      },
      ...(typeof count === 'number' ? { totalCount: count } : {})
    }
  }

  // Fetch items.
  const items = await fetchAllItems({
    owner: args.owner,
    ownerType: args.ownerType,
    projectNumber: args.projectNumber,
    query: effectiveQuery
  })
  if (!items.ok) {
    return {
      ok: false,
      error: items.error,
      ...(typeof items.totalCount === 'number' ? { totalCount: items.totalCount } : {})
    }
  }

  const table: GitHubProjectTable = {
    project: {
      id: project.id,
      owner: args.owner,
      ownerType: args.ownerType,
      number: args.projectNumber,
      title: project.title,
      url: project.url
    },
    selectedView,
    rows: items.rows,
    totalCount: items.totalCount,
    parentFieldDropped: items.parentFieldDropped
  }
  return { ok: true, data: table }
}

// ─── listAccessibleProjects ────────────────────────────────────────────

type RawViewerDiscovery = {
  viewer?: {
    login?: string
    projectsV2?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: Array<{
        id?: string
        number?: number
        title?: string
        url?: string
        owner?: { __typename?: string; login?: string }
      } | null>
    }
    organizations?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: Array<{
        login?: string
        projectsV2?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: Array<{ id?: string; number?: number; title?: string; url?: string } | null>
        }
      } | null>
    }
  }
}

export async function listAccessibleProjects(): Promise<ListAccessibleProjectsResult> {
  const viewerProjects: GitHubProjectSummary[] = []
  const orgProjects: GitHubProjectSummary[] = []
  // Why: per-org failures are collected so the picker can render a "some orgs
  // didn't load" banner with the affected logins, instead of aborting the
  // whole discovery on the first 504. Users with flaky org fetches still get
  // viewer + other orgs in the list.
  const partialFailures: { owner: string; message: string }[] = []
  let viewerLogin: string | null = null

  // 1) Viewer projects (paginated, single owner so cap at DISCOVERY_PROJECTS_PER_OWNER total).
  let viewerCursor: string | null = null
  let viewerMore = true
  let viewerFetched = 0
  while (viewerMore && viewerFetched < DISCOVERY_PROJECTS_PER_OWNER) {
    const afterArg = viewerCursor ? ', after: $after' : ''
    const afterVar = viewerCursor ? '$after:String!' : ''
    const query = `
      query${afterVar ? `(${afterVar})` : ''} {
        viewer {
          login
          projectsV2(first:${DISCOVERY_PROJECTS_PER_ORG}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id number title url
              owner { __typename ... on Organization { login } ... on User { login } }
            }
          }
        }
      }
    `
    const vars: GraphqlVars = {}
    if (viewerCursor) vars.after = viewerCursor
    const res = await runGraphql<RawViewerDiscovery>(query, vars)
    if (!res.ok) {
      // Why: a viewer-level failure is structural — if we can't list the
      // user's own projects, we have nothing to build on. Propagate as a
      // hard error instead of returning partial. Org-level errors below
      // are non-fatal because the viewer slice is still useful on its own.
      return { ok: false, error: res.error }
    }
    if (!res.data.viewer) {
      return { ok: false, error: driftError('viewer missing') }
    }
    if (viewerLogin === null) viewerLogin = res.data.viewer.login ?? null
    const nodes = res.data.viewer.projectsV2?.nodes ?? []
    for (const n of nodes) {
      if (!n || typeof n.id !== 'string' || typeof n.number !== 'number') continue
      const ownerLogin = n.owner?.login ?? viewerLogin ?? ''
      const ownerType: GitHubProjectOwnerType =
        n.owner?.__typename === 'Organization' ? 'organization' : 'user'
      viewerProjects.push({
        id: n.id,
        owner: ownerLogin,
        ownerType,
        number: n.number,
        title: n.title ?? '',
        url: n.url ?? '',
        source: 'viewer'
      })
      viewerFetched++
      if (viewerFetched >= DISCOVERY_PROJECTS_PER_OWNER) break
    }
    const pi = res.data.viewer.projectsV2?.pageInfo
    viewerMore = pi?.hasNextPage === true && typeof pi.endCursor === 'string'
    viewerCursor = viewerMore ? (pi?.endCursor ?? null) : null
  }

  // 2) Organizations the viewer belongs to, each with its projectsV2.
  // Why: we intentionally drop the per-org continuation loop that previously
  // ran `organization(login).projectsV2(first:50, after:$after)` when the
  // first nested page had more. That inner loop was the dominant cost
  // multiplier and the most common 504 source — a single slow org would
  // serially block the picker for tens of seconds. Users with more than
  // DISCOVERY_PROJECTS_PER_ORG projects in a given org can still paste a
  // URL to reach them; the picker is discovery, not an exhaustive index.
  let orgCursor: string | null = null
  let orgMore = true
  let orgsSeen = 0
  while (orgMore && orgsSeen < DISCOVERY_MAX_ORGS) {
    const afterArg = orgCursor ? ', after: $orgAfter' : ''
    const afterVar = orgCursor ? '$orgAfter:String!' : ''
    const query = `
      query${afterVar ? `(${afterVar})` : ''} {
        viewer {
          organizations(first:${DISCOVERY_ORG_PAGE_SIZE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              login
              projectsV2(first:${DISCOVERY_PROJECTS_PER_ORG}) {
                pageInfo { hasNextPage endCursor }
                nodes { id number title url }
              }
            }
          }
        }
      }
    `
    const vars: GraphqlVars = {}
    if (orgCursor) vars.orgAfter = orgCursor
    const res = await runGraphql<RawViewerDiscovery>(query, vars)
    if (!res.ok) {
      // Why: the org-listing query itself failed (not a nested projectsV2).
      // Record it as a partial failure against a synthetic `*` owner so the
      // UI banner explains why additional orgs aren't listed, but keep any
      // viewer projects we already collected. This is the critical 504 path
      // the user reported in the ProjectPicker.
      partialFailures.push({ owner: '*', message: res.error.message })
      break
    }
    const orgs = res.data.viewer?.organizations?.nodes ?? []
    for (const org of orgs) {
      if (!org || typeof org.login !== 'string') continue
      if (orgsSeen >= DISCOVERY_MAX_ORGS) break
      orgsSeen++
      const login = org.login
      // Cache owner → ownerType for downstream paste/resolve even when the
      // nested projects query was empty or partially failed — paste-to-add
      // uses this to disambiguate /orgs/ vs /users/ URLs.
      ownerTypeCache.set(login, 'organization')
      const nodes = org.projectsV2?.nodes ?? []
      let ownerCount = 0
      for (const n of nodes) {
        if (!n || typeof n.id !== 'string' || typeof n.number !== 'number') continue
        if (ownerCount >= DISCOVERY_PROJECTS_PER_OWNER) break
        orgProjects.push({
          id: n.id,
          owner: login,
          ownerType: 'organization',
          number: n.number,
          title: n.title ?? '',
          url: n.url ?? '',
          source: `org:${login}`
        })
        ownerCount++
      }
    }
    const pi = res.data.viewer?.organizations?.pageInfo
    orgMore = pi?.hasNextPage === true && typeof pi.endCursor === 'string'
    orgCursor = orgMore ? (pi?.endCursor ?? null) : null
  }

  if (viewerLogin) ownerTypeCache.set(viewerLogin, 'user')

  return {
    ok: true,
    projects: [...viewerProjects, ...orgProjects],
    ...(partialFailures.length > 0 ? { partialFailures } : {})
  }
}

// ─── resolveProjectRef ─────────────────────────────────────────────────

type ParsedPaste =
  | { kind: 'org'; owner: string; number: number; viewNumber?: number }
  | { kind: 'user'; owner: string; number: number; viewNumber?: number }
  | { kind: 'bare'; owner: string; number: number }

export function parseProjectPaste(input: string): ParsedPaste | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // URL forms
  const urlRe = /^https?:\/\/github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)(?:\/views\/(\d+))?/i
  const m = trimmed.match(urlRe)
  if (m) {
    const [, kindSeg, owner, nStr, vStr] = m
    const number = parseInt(nStr, 10)
    if (!Number.isInteger(number) || number < 1) return null
    if (!isValidOwnerSlug(owner)) return null
    const viewNumber = vStr ? parseInt(vStr, 10) : undefined
    return {
      kind: kindSeg === 'orgs' ? 'org' : 'user',
      owner,
      number,
      ...(viewNumber !== undefined && Number.isInteger(viewNumber) && viewNumber >= 1
        ? { viewNumber }
        : {})
    }
  }
  // owner/number shorthand — owner alphabet matches OWNER_SLUG_RE.
  const shortRe = /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/
  const sm = trimmed.match(shortRe)
  if (sm) {
    const number = parseInt(sm[2], 10)
    if (!Number.isInteger(number) || number < 1) return null
    return { kind: 'bare', owner: sm[1], number }
  }
  return null
}

async function resolveOwnerType(
  owner: string,
  preferred: GitHubProjectOwnerType | null
): Promise<
  { ok: true; ownerType: GitHubProjectOwnerType; title: string }
  | { ok: false; error: GitHubProjectViewError }
> {
  const tryOne = async (
    ot: GitHubProjectOwnerType,
    num: number | null
  ): Promise<
    { ok: true; title: string } | { ok: false; error: GitHubProjectViewError }
  > => {
    const root = ownerQueryRoot(ot)
    // If number is provided, fetch the project title; else just confirm owner exists.
    const query = num
      ? `
        query($owner:String!, $num:Int!) {
          ${root}(login:$owner) { projectV2(number:$num) { id title } }
        }
      `
      : `
        query($owner:String!) {
          ${root}(login:$owner) { login }
        }
      `
    const vars: GraphqlVars = { owner }
    if (num) vars.num = num
    const res = await runGraphql<
      Record<string, { projectV2?: { id?: string; title?: string } | null; login?: string } | null>
    >(query, vars)
    if (!res.ok) return { ok: false, error: res.error }
    const top = res.data[root]
    if (!top) return { ok: false, error: { type: 'not_found', message: 'Owner not found.' } }
    if (num) {
      const p = top.projectV2
      if (!p || typeof p.id !== 'string') {
        return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
      }
      return { ok: true, title: p.title ?? '' }
    }
    return { ok: true, title: '' }
  }

  const cached = ownerTypeCache.get(owner)
  const candidates: GitHubProjectOwnerType[] = preferred
    ? [preferred]
    : cached
      ? [cached]
      : ['organization', 'user']
  const fallback: GitHubProjectOwnerType[] = preferred
    ? []
    : cached
      ? (cached === 'organization' ? ['user'] : ['organization'])
      : []
  const ordered = [...candidates, ...fallback]
  let lastError: GitHubProjectViewError | null = null
  for (const ot of ordered) {
    const r = await tryOne(ot, null)
    if (r.ok) {
      ownerTypeCache.set(owner, ot)
      return { ok: true, ownerType: ot, title: r.title }
    }
    lastError = r.error
    if (r.error.type !== 'not_found') {
      // Non-NOT_FOUND errors (auth, network, rate) should not trigger fallback.
      return { ok: false, error: r.error }
    }
  }
  ownerTypeCache.set(owner, null)
  return {
    ok: false,
    error: lastError ?? { type: 'not_found', message: 'Owner not found.' }
  }
}

export async function resolveProjectRef(
  args: ResolveProjectRefArgs
): Promise<ResolveProjectRefResult> {
  if (typeof args.input !== 'string' || !args.input.trim()) {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'Input required.' }
    }
  }
  const parsed = parseProjectPaste(args.input)
  if (!parsed) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Could not parse input. Expected a GitHub project URL or `owner/number`.'
      }
    }
  }
  const preferred: GitHubProjectOwnerType | null =
    parsed.kind === 'org' ? 'organization' : parsed.kind === 'user' ? 'user' : null
  // Verify by fetching project title.
  const ownerRes = await resolveOwnerType(parsed.owner, preferred)
  if (!ownerRes.ok) return { ok: false, error: ownerRes.error }
  const ownerType = ownerRes.ownerType
  const root = ownerQueryRoot(ownerType)
  const query = `
    query($owner:String!, $num:Int!) {
      ${root}(login:$owner) { projectV2(number:$num) { id title } }
    }
  `
  const res = await runGraphql<
    Record<string, { projectV2?: { id?: string; title?: string } | null } | null>
  >(query, { owner: parsed.owner, num: parsed.number })
  if (!res.ok) return { ok: false, error: res.error }
  const p = res.data[root]?.projectV2
  if (!p || typeof p.id !== 'string') {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  return {
    ok: true,
    owner: parsed.owner,
    ownerType,
    number: parsed.number,
    title: p.title ?? ''
  }
}

// ─── listProjectViews ──────────────────────────────────────────────────

export async function listProjectViews(
  args: ListProjectViewsArgs
): Promise<ListProjectViewsResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) return { ok: false, error: ownerCheck.error }
  const numCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numCheck.ok) return { ok: false, error: numCheck.error }
  if (args.ownerType !== 'organization' && args.ownerType !== 'user') {
    return { ok: false, error: { type: 'validation_error', message: 'Invalid ownerType.' } }
  }
  const summaries: GitHubProjectViewSummary[] = []
  let cursor: string | null = null
  while (true) {
    const page = await fetchProjectViewsPage({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      after: cursor
    })
    if (!page.ok) return { ok: false, error: page.error }
    for (const v of page.views) {
      if (typeof v.id !== 'string' || typeof v.layout !== 'string') continue
      summaries.push({
        id: v.id,
        number: typeof v.number === 'number' ? v.number : 0,
        name: typeof v.name === 'string' ? v.name : '',
        layout: v.layout as GitHubProjectViewLayout
      })
    }
    if (!page.hasNextPage) break
    cursor = page.endCursor
    if (typeof cursor !== 'string') break
  }
  return { ok: true, views: summaries }
}

// ─── Project field mutations ──────────────────────────────────────────

class UnknownFieldMutationKindError extends Error {
  constructor(kind: string) {
    super(`Unknown project field mutation kind: ${kind}`)
  }
}

function graphqlValueForFieldMutation(value: GitHubProjectFieldMutationValue): string {
  // Serialize the value fragment for the GraphQL mutation. We use GraphQL
  // variables for every dynamic piece, so here we only pick the variable name
  // to reference per value kind.
  switch (value.kind) {
    case 'single-select':
      return 'singleSelectOptionId: $value'
    case 'iteration':
      return 'iterationId: $value'
    case 'text':
      return 'text: $value'
    case 'number':
      return 'number: $value'
    case 'date':
      return 'date: $value'
    default:
      // Why: defensive default. If a new mutation kind is added to the type
      // but not handled here, returning undefined would silently produce a
      // broken GraphQL query. Throw so updateProjectItemFieldValue can map it
      // to a validation_error rather than dispatching a malformed mutation.
      throw new UnknownFieldMutationKindError((value as { kind: string }).kind)
  }
}

function mutationValueVar(value: GitHubProjectFieldMutationValue): {
  type: string
  val: string | number
} {
  switch (value.kind) {
    case 'single-select':
      return { type: 'String!', val: value.optionId }
    case 'iteration':
      return { type: 'String!', val: value.iterationId }
    case 'text':
      return { type: 'String!', val: value.text }
    case 'number':
      return { type: 'Float!', val: value.number }
    case 'date':
      return { type: 'Date!', val: value.date }
    default:
      // Why: see graphqlValueForFieldMutation — surface unknown kinds loudly
      // instead of returning undefined and dispatching an invalid mutation.
      throw new UnknownFieldMutationKindError((value as { kind: string }).kind)
  }
}

export async function updateProjectItemFieldValue(
  args: UpdateProjectItemFieldArgs
): Promise<GitHubProjectMutationResult> {
  if (!args.projectId || !args.itemId || !args.fieldId) {
    return { ok: false, error: { type: 'validation_error', message: 'Missing ids.' } }
  }
  let valFrag: string
  let valVar: { type: string; val: string | number }
  try {
    valFrag = graphqlValueForFieldMutation(args.value)
    valVar = mutationValueVar(args.value)
  } catch (err) {
    if (err instanceof UnknownFieldMutationKindError) {
      return { ok: false, error: { type: 'validation_error', message: err.message } }
    }
    throw err
  }
  const query = `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $value:${valVar.type}) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { ${valFrag} }
      }) { projectV2Item { id } }
    }
  `
  const vars: GraphqlVars = {
    projectId: args.projectId,
    itemId: args.itemId,
    fieldId: args.fieldId,
    value: valVar.val
  }
  const res = await runGraphql<unknown>(query, vars)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true }
}

export async function clearProjectItemFieldValue(
  args: ClearProjectItemFieldArgs
): Promise<GitHubProjectMutationResult> {
  if (!args.projectId || !args.itemId || !args.fieldId) {
    return { ok: false, error: { type: 'validation_error', message: 'Missing ids.' } }
  }
  const query = `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
      }) { projectV2Item { id } }
    }
  `
  const res = await runGraphql<unknown>(query, {
    projectId: args.projectId,
    itemId: args.itemId,
    fieldId: args.fieldId
  })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true }
}

// ─── Slug-addressed issue/PR mutations ────────────────────────────────

function validateSlugArgs(
  owner: unknown,
  repo: unknown
): { ok: true } | { ok: false; error: GitHubProjectViewError } {
  const o = assertSlug(owner, 'owner')
  if (!o.ok) return { ok: false, error: o.error }
  const r = assertSlug(repo, 'repo')
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true }
}

export async function updateIssueBySlug(
  args: UpdateIssueBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) return { ok: false, error: n.error }
  if (!args.updates || typeof args.updates !== 'object') {
    return { ok: false, error: { type: 'validation_error', message: 'Updates required.' } }
  }
  const { title, body, state, addLabels, removeLabels, addAssignees, removeAssignees } = args.updates

  // Title / body / state go through PATCH /repos/{owner}/{repo}/issues/{n}.
  // Labels/assignees go through their dedicated endpoints.
  const base = `repos/${args.owner}/${args.repo}/issues/${args.number}`

  // 1) PATCH body
  if (title !== undefined || body !== undefined || state !== undefined) {
    const patchArgs: string[] = ['-X', 'PATCH', base]
    if (title !== undefined) patchArgs.push('--raw-field', `title=${title}`)
    if (body !== undefined) patchArgs.push('--raw-field', `body=${body}`)
    if (state !== undefined) patchArgs.push('--raw-field', `state=${state}`)
    const r = await runRest<unknown>(patchArgs)
    if (!r.ok) return { ok: false, error: r.error }
  }

  // 2) Labels — collapse multi-delete fan-out into a single PUT when removing
  //    >1 label. PUT /labels replaces the entire label set, so we fetch the
  //    current labels first and compute the resulting set client-side. This
  //    turns an N-delete + 1-add (=N+1 calls) into 1-fetch + 1-PUT (=2 calls)
  //    once removeLabels has more than one entry, capping the cost at 2 even
  //    for a "remove all 20 labels" mutation.
  const removeCount = removeLabels?.length ?? 0
  const addCount = addLabels?.length ?? 0
  if (removeCount > 1) {
    type RawLabelResp = { name?: string }[]
    const fetched = await runRest<RawLabelResp>(['-X', 'GET', `${base}/labels`])
    if (!fetched.ok) return { ok: false, error: fetched.error }
    const currentNames = new Set(
      fetched.data.map((l) => l.name).filter((n): n is string => typeof n === 'string')
    )
    for (const l of removeLabels ?? []) currentNames.delete(l)
    for (const l of addLabels ?? []) currentNames.add(l)
    const putArgs = ['-X', 'PUT', `${base}/labels`]
    for (const name of currentNames) putArgs.push('--raw-field', `labels[]=${name}`)
    // Why: PUT with empty `labels[]` clears all labels — that's the desired
    // outcome when the user removed every label. gh requires `--raw-field` to
    // construct the request body; an empty form is a valid clear-all.
    const r = await runRest<unknown>(putArgs)
    if (!r.ok) return { ok: false, error: r.error }
  } else {
    if (addCount > 0) {
      const restArgs = ['-X', 'POST', `${base}/labels`]
      for (const l of addLabels ?? []) restArgs.push('--raw-field', `labels[]=${l}`)
      const r = await runRest<unknown>(restArgs)
      if (!r.ok) return { ok: false, error: r.error }
    }
    if (removeCount === 1) {
      const r = await runRest<unknown>(
        ['-X', 'DELETE', `${base}/labels/${encodeURIComponent(removeLabels![0])}`],
        undefined,
        'core',
        { expectEmpty: true }
      )
      if (!r.ok && r.error.type !== 'not_found') return { ok: false, error: r.error }
    }
  }

  // 3) Assignees — POST and DELETE both accept arrays in a single call, so
  //    add/remove are at most 2 calls regardless of array size.
  if (addAssignees && addAssignees.length > 0) {
    const restArgs = ['-X', 'POST', `${base}/assignees`]
    for (const u of addAssignees) restArgs.push('--raw-field', `assignees[]=${u}`)
    const r = await runRest<unknown>(restArgs)
    if (!r.ok) return { ok: false, error: r.error }
  }
  if (removeAssignees && removeAssignees.length > 0) {
    const restArgs = ['-X', 'DELETE', `${base}/assignees`]
    for (const u of removeAssignees) restArgs.push('--raw-field', `assignees[]=${u}`)
    const r = await runRest<unknown>(restArgs)
    if (!r.ok) return { ok: false, error: r.error }
  }
  return { ok: true }
}

export async function updatePullRequestBySlug(
  args: UpdatePullRequestBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) return { ok: false, error: n.error }
  if (!args.updates || typeof args.updates !== 'object') {
    return { ok: false, error: { type: 'validation_error', message: 'Updates required.' } }
  }
  const patchArgs: string[] = ['-X', 'PATCH', `repos/${args.owner}/${args.repo}/pulls/${args.number}`]
  // Why: count fields explicitly rather than inferring from patchArgs.length —
  // adding a future header/flag arg silently breaks an array-length check.
  let fieldCount = 0
  if (args.updates.title !== undefined) {
    patchArgs.push('--raw-field', `title=${args.updates.title}`)
    fieldCount++
  }
  if (args.updates.body !== undefined) {
    patchArgs.push('--raw-field', `body=${args.updates.body}`)
    fieldCount++
  }
  if (fieldCount === 0) {
    // No fields to update — nothing to do.
    return { ok: true }
  }
  const r = await runRest<unknown>(patchArgs)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true }
}

type RawIssueCommentResponse = {
  id?: number
  user?: { login?: string; avatar_url?: string; type?: string } | null
  body?: string
  created_at?: string
  html_url?: string
}

function mapIssueComment(data: RawIssueCommentResponse, fallbackBody: string): PRComment {
  return {
    id: data.id ?? Date.now(),
    author: data.user?.login ?? 'You',
    authorAvatarUrl: data.user?.avatar_url ?? '',
    body: data.body ?? fallbackBody,
    createdAt: data.created_at ?? new Date().toISOString(),
    url: data.html_url ?? '',
    isBot: data.user?.type === 'Bot'
  }
}

export async function addIssueCommentBySlug(
  args: AddIssueCommentBySlugArgs
): Promise<GitHubProjectCommentMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) return { ok: false, error: n.error }
  if (typeof args.body !== 'string' || !args.body.trim()) {
    return { ok: false, error: { type: 'validation_error', message: 'Comment body required.' } }
  }
  const r = await runRest<RawIssueCommentResponse>([
    '-X',
    'POST',
    `repos/${args.owner}/${args.repo}/issues/${args.number}/comments`,
    '--raw-field',
    `body=${args.body}`
  ])
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, comment: mapIssueComment(r.data, args.body) }
}

export async function updateIssueCommentBySlug(
  args: UpdateIssueCommentBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const n = assertPositiveInt(args.commentId, 'commentId')
  if (!n.ok) return { ok: false, error: n.error }
  if (typeof args.body !== 'string' || !args.body.trim()) {
    return { ok: false, error: { type: 'validation_error', message: 'Comment body required.' } }
  }
  const r = await runRest<unknown>([
    '-X',
    'PATCH',
    `repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`,
    '--raw-field',
    `body=${args.body}`
  ])
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true }
}

export async function deleteIssueCommentBySlug(
  args: DeleteIssueCommentBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const n = assertPositiveInt(args.commentId, 'commentId')
  if (!n.ok) return { ok: false, error: n.error }
  const r = await runRest<unknown>(
    ['-X', 'DELETE', `repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`],
    undefined,
    'core',
    { expectEmpty: true }
  )
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true }
}

// ─── Slug-addressed picker sources ────────────────────────────────────

export async function listLabelsBySlug(
  args: ListLabelsBySlugArgs
): Promise<ListLabelsBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const guard = rateLimitGuard('core')
  if (guard.blocked) return { ok: false, error: rateLimitedError(guard) }
  await acquire()
  // Why: `--paginate` may fan out to multiple pages; we can only reasonably
  // estimate a 1-call spend up front. The next probe will reconcile.
  noteRateLimitSpend('core')
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', '--paginate', `repos/${args.owner}/${args.repo}/labels`, '--jq', '.[].name'],
      { encoding: 'utf-8' }
    )
    return {
      ok: true,
      labels: stdout
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
    }
  } catch (err) {
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, maybeStdout) }
  } finally {
    release()
  }
}

export async function listAssignableUsersBySlug(
  args: ListAssignableUsersBySlugArgs
): Promise<ListAssignableUsersBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  // Seed logins merge after the fetch so callers can include currently-visible
  // assignees even if the repo participant search is sparse.
  const result: GitHubAssignableUser[] = []
  const guard = rateLimitGuard('core')
  if (guard.blocked) return { ok: false, error: rateLimitedError(guard) }
  await acquire()
  noteRateLimitSpend('core')
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${args.owner}/${args.repo}/assignees`,
        '--jq',
        '.[] | {login: .login, name: null, avatarUrl: .avatar_url}'
      ],
      { encoding: 'utf-8' }
    )
    for (const line of stdout.trim().split('\n').filter((l) => l.length > 0)) {
      try {
        const u = JSON.parse(line) as { login?: string; avatarUrl?: string; name?: string | null }
        if (typeof u.login === 'string') {
          result.push({ login: u.login, name: u.name ?? null, avatarUrl: u.avatarUrl ?? '' })
        }
      } catch {
        // skip malformed jq line
      }
    }
  } catch (err) {
    const { stderr } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, '') }
  } finally {
    release()
  }
  if (args.seedLogins) {
    const seen = new Set(result.map((u) => u.login))
    for (const login of args.seedLogins) {
      if (typeof login === 'string' && !seen.has(login)) {
        result.push({ login, name: null, avatarUrl: '' })
        seen.add(login)
      }
    }
  }
  return { ok: true, users: result }
}

// Why: Issue Types are a repo-level taxonomy (Bug/Feature/Task/etc) only
// available on repos opted into typed-issues. Empty list (or schema_drift on
// older GitHub deployments) is the legitimate "this repo doesn't use issue
// types" signal — callers should treat it as "no editor".
export async function listIssueTypesBySlug(
  args: ListIssueTypesBySlugArgs
): Promise<ListIssueTypesBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const query = `
    query($owner:String!, $repo:String!) {
      repository(owner:$owner, name:$repo) {
        issueTypes(first:50) {
          nodes { id name color description }
        }
      }
    }
  `
  const res = await runGraphql<{
    repository?: {
      issueTypes?: {
        nodes?: Array<{
          id?: string
          name?: string
          color?: string | null
          description?: string | null
        } | null>
      } | null
    } | null
  }>(query, { owner: args.owner, repo: args.repo })
  if (!res.ok) {
    // Why: repos without issue types respond with a GraphQL error claiming the
    // `issueTypes` field is unknown. Map that to an empty list so the UI shows
    // "no editor" instead of an angry banner.
    if (res.error.type === 'schema_drift' || res.error.type === 'validation_error') {
      return { ok: true, types: [] }
    }
    return { ok: false, error: res.error }
  }
  const nodes = res.data.repository?.issueTypes?.nodes ?? []
  const types = nodes
    .filter((n): n is NonNullable<typeof n> => n !== null && typeof n.id === 'string' && typeof n.name === 'string')
    .map((n) => ({
      id: n.id as string,
      name: n.name as string,
      color: typeof n.color === 'string' ? n.color : null,
      description: typeof n.description === 'string' ? n.description : null
    }))
  return { ok: true, types }
}

export async function updateIssueTypeBySlug(
  args: UpdateIssueTypeBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) return { ok: false, error: n.error }
  // Why: `updateIssueIssueType` is the dedicated mutation; passing null for
  // `issueTypeId` clears the type. We resolve the issue id via a lightweight
  // GraphQL lookup because the REST endpoint doesn't accept issue types.
  const lookup = await runGraphql<{
    repository?: { issue?: { id?: string } | null } | null
  }>(
    `query($owner:String!, $repo:String!, $num:Int!) {
       repository(owner:$owner, name:$repo) { issue(number:$num) { id } }
     }`,
    { owner: args.owner, repo: args.repo, num: args.number }
  )
  if (!lookup.ok) return { ok: false, error: lookup.error }
  const issueId = lookup.data.repository?.issue?.id
  if (!issueId) {
    return { ok: false, error: { type: 'not_found', message: 'Issue not found.' } }
  }
  // Why: build the mutation conditionally so a null clear doesn't have to
  // smuggle a null GraphQL variable through `gh api graphql -f`. The
  // mutation accepts a literal `null` in the input object directly.
  const query = args.issueTypeId
    ? `
        mutation($issueId:ID!, $issueTypeId:ID!) {
          updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $issueTypeId }) {
            issue { id }
          }
        }
      `
    : `
        mutation($issueId:ID!) {
          updateIssueIssueType(input: { issueId: $issueId, issueTypeId: null }) {
            issue { id }
          }
        }
      `
  const vars: GraphqlVars = args.issueTypeId
    ? { issueId, issueTypeId: args.issueTypeId }
    : { issueId }
  const res = await runGraphql<unknown>(query, vars)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true }
}

// ─── Slug-addressed work-item details ─────────────────────────────────

export async function getWorkItemDetailsBySlug(
  args: ProjectWorkItemDetailsBySlugArgs
): Promise<ProjectWorkItemDetailsBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) return v
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) return { ok: false, error: n.error }
  if (args.type !== 'issue' && args.type !== 'pr') {
    return { ok: false, error: { type: 'validation_error', message: 'Invalid type.' } }
  }

  // Single GraphQL round-trip to fetch the issue/PR summary + comments + labels + assignees.
  const contentFrag =
    args.type === 'issue'
      ? `
        issue(number:$num) {
          id number title url state stateReason updatedAt
          body
          author { login }
          labels(first:50) { nodes { name } }
          assignees(first:50) { nodes { login } }
          participants(first:50) { nodes { login name avatarUrl } }
          comments(first:100) {
            nodes {
              databaseId
              author { login avatarUrl __typename }
              body createdAt url
            }
          }
        }
      `
      : `
        pullRequest(number:$num) {
          id number title url state isDraft updatedAt headRefName baseRefName
          body
          author { login }
          labels(first:50) { nodes { name } }
          assignees(first:50) { nodes { login } }
          participants(first:50) { nodes { login name avatarUrl } }
          comments(first:100) {
            nodes {
              databaseId
              author { login avatarUrl __typename }
              body createdAt url
            }
          }
        }
      `
  const query = `
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        ${contentFrag}
      }
    }
  `
  const res = await runGraphql<{
    repository?: {
      issue?: RawContent & {
        updatedAt?: string
        body?: string
        author?: { login?: string } | null
        participants?: { nodes?: RawUser[] }
        comments?: {
          nodes?: Array<{
            databaseId?: number
            author?: { login?: string; avatarUrl?: string; __typename?: string } | null
            body?: string
            createdAt?: string
            url?: string
          } | null>
        }
      } | null
      pullRequest?: RawContent & {
        updatedAt?: string
        body?: string
        headRefName?: string
        baseRefName?: string
        author?: { login?: string } | null
        participants?: { nodes?: RawUser[] }
        comments?: {
          nodes?: Array<{
            databaseId?: number
            author?: { login?: string; avatarUrl?: string; __typename?: string } | null
            body?: string
            createdAt?: string
            url?: string
          } | null>
        }
      } | null
    } | null
  }>(query, { owner: args.owner, repo: args.repo, num: args.number })
  if (!res.ok) return { ok: false, error: res.error }
  const raw = args.type === 'issue' ? res.data.repository?.issue : res.data.repository?.pullRequest
  if (!raw) {
    return { ok: false, error: { type: 'not_found', message: 'Item not found.' } }
  }

  const labels = (raw.labels?.nodes ?? [])
    .map((l) => l?.name)
    .filter((n): n is string => typeof n === 'string')
  const assignees = (raw.assignees?.nodes ?? [])
    .map((a) => a?.login)
    .filter((l): l is string => typeof l === 'string')
  const comments: PRComment[] = []
  for (const c of raw.comments?.nodes ?? []) {
    if (!c || typeof c.body !== 'string') continue
    comments.push({
      id: typeof c.databaseId === 'number' ? c.databaseId : Date.now(),
      author: c.author?.login ?? '',
      authorAvatarUrl: c.author?.avatarUrl ?? '',
      body: c.body,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
      url: typeof c.url === 'string' ? c.url : '',
      isBot: c.author?.__typename === 'Bot'
    })
  }
  const participants: GitHubAssignableUser[] = []
  for (const p of raw.participants?.nodes ?? []) {
    if (p && typeof p.login === 'string') {
      participants.push({ login: p.login, name: p.name ?? null, avatarUrl: p.avatarUrl ?? '' })
    }
  }

  const state: 'open' | 'closed' | 'merged' | 'draft' =
    args.type === 'pr'
      ? raw.isDraft
        ? 'draft'
        : raw.state === 'MERGED'
          ? 'merged'
          : raw.state === 'CLOSED'
            ? 'closed'
            : 'open'
      : raw.state === 'CLOSED'
        ? 'closed'
        : 'open'

  const details: GitHubWorkItemDetails = {
    item: {
      id: typeof raw.id === 'string' ? raw.id : '',
      type: args.type,
      number: typeof raw.number === 'number' ? raw.number : args.number,
      title: typeof raw.title === 'string' ? raw.title : '',
      state,
      url: typeof raw.url === 'string' ? raw.url : '',
      labels,
      updatedAt:
        typeof (raw as { updatedAt?: string }).updatedAt === 'string'
          ? (raw as { updatedAt: string }).updatedAt
          : '',
      author:
        typeof (raw as { author?: { login?: string } | null }).author?.login === 'string'
          ? ((raw as { author: { login: string } }).author.login as string)
          : null,
      branchName:
        args.type === 'pr' && typeof (raw as { headRefName?: string }).headRefName === 'string'
          ? ((raw as { headRefName: string }).headRefName as string)
          : undefined,
      baseRefName:
        args.type === 'pr' && typeof (raw as { baseRefName?: string }).baseRefName === 'string'
          ? ((raw as { baseRefName: string }).baseRefName as string)
          : undefined
    },
    body: typeof raw.body === 'string' ? raw.body : '',
    comments,
    participants,
    // Why: PR files/checks/review-thread tabs depend on a local repo path and
    // are out of Project-mode slug scope for v1. Omit them here; the dialog
    // branches on their absence and hides those tabs.
    ...(args.type === 'issue' ? { assignees } : {})
  }
  return { ok: true, details }
}
