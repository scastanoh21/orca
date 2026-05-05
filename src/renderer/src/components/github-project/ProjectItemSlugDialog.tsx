// Why: when a Project row's `content.repository` does not match any
// registered Orca repo, the main `GitHubItemDialog` cannot be used in
// repo-backed mode — it requires a `repoPath` for label/assignee pickers
// and conversation details. Per design doc §Dialog editing from Project
// rows, the dialog for unknown-repo rows is allowed to be a simplified
// surface (conversation + title/body/labels/assignees/comments) with
// Files, Checks, and review-thread tabs hidden. This component is that
// simplified surface; it also routes every write through slug-addressed
// mutation helpers and patches the Project table cache on success.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleDot,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  Send,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type {
  GitHubAssignableUser,
  GitHubWorkItemDetails,
  PRComment
} from '../../../../shared/types'
import type { GitHubItemDialogProjectOrigin } from '@/components/GitHubItemDialog'

type Props = {
  projectOrigin: GitHubItemDialogProjectOrigin | null
  /** Present if the repo is registered; when set, Start work is enabled
   *  and calls this callback with the matched work item + repo id. Unknown
   *  repos instead raise the repo-not-in-orca prompt from the parent. */
  onStartWork?: () => void
  startWorkEnabled?: boolean
  onClose: () => void
}

export default function ProjectItemSlugDialog({
  projectOrigin,
  onStartWork,
  startWorkEnabled,
  onClose
}: Props): React.JSX.Element {
  const open = projectOrigin !== null

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px] lg:max-w-[860px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>GitHub item</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>Project row preview.</SheetDescription>
        </VisuallyHidden.Root>
        {projectOrigin ? (
          <SlugDialogBody
            projectOrigin={projectOrigin}
            onStartWork={onStartWork}
            startWorkEnabled={!!startWorkEnabled}
            onClose={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function SlugDialogBody({
  projectOrigin,
  onStartWork,
  startWorkEnabled,
  onClose
}: {
  projectOrigin: GitHubItemDialogProjectOrigin
  onStartWork?: () => void
  startWorkEnabled: boolean
  onClose: () => void
}): React.JSX.Element {
  const { owner, repo, number, type, cacheKey } = projectOrigin
  const patchProjectIssueOrPr = useAppStore((s) => s.patchProjectIssueOrPr)
  const projectViewCache = useAppStore((s) => s.projectViewCache)

  // Why: the Project row is the source of truth for the list-side columns;
  // reading it reactively here keeps the dialog in sync with optimistic
  // patches applied by the table (e.g. inline assignee edits).
  const row = useMemo(() => {
    const table = projectViewCache[cacheKey]?.data
    if (!table) return null
    return table.rows.find(
      (r) => r.content.number === number && r.content.repository?.toLowerCase() === `${owner}/${repo}`.toLowerCase()
    ) ?? null
  }, [projectViewCache, cacheKey, owner, repo, number])

  const [details, setDetails] = useState<GitHubWorkItemDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    requestIdRef.current += 1
    const rid = requestIdRef.current
    setLoading(true)
    setError(null)
    setDetails(null)
    window.api.gh
      .projectWorkItemDetailsBySlug({ owner, repo, number, type })
      .then((res) => {
        if (rid !== requestIdRef.current) return
        if (res.ok) {
          setDetails(res.details)
        } else {
          setError(res.error.message)
        }
      })
      .catch((err) => {
        if (rid !== requestIdRef.current) return
        setError(err instanceof Error ? err.message : 'Failed to load details')
      })
      .finally(() => {
        if (rid !== requestIdRef.current) return
        setLoading(false)
      })
  }, [owner, repo, number, type])

  const title = row?.content.title ?? details?.item.title ?? ''
  const url = row?.content.url ?? details?.item.url ?? null
  const Icon = type === 'pr' ? GitPullRequest : CircleDot

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  const commitTitle = useCallback(async () => {
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (!next || next === title) return
    const res = await patchProjectIssueOrPr(cacheKey, row?.id ?? '', { title: next })
    if (!res.ok) toast.error(res.error.message)
  }, [titleDraft, title, patchProjectIssueOrPr, cacheKey, row?.id])

  const [editingBody, setEditingBody] = useState(false)
  const [bodyDraft, setBodyDraft] = useState('')
  const body = details?.body ?? ''
  const commitBody = useCallback(async () => {
    setEditingBody(false)
    if (bodyDraft === body) return
    const res = await patchProjectIssueOrPr(cacheKey, row?.id ?? '', { body: bodyDraft })
    if (!res.ok) {
      toast.error(res.error.message)
      return
    }
    setDetails((prev) => (prev ? { ...prev, body: bodyDraft } : prev))
  }, [bodyDraft, body, patchProjectIssueOrPr, cacheKey, row?.id])

  const labels = row?.content.labels.map((l) => l.name) ?? []
  const assignees = row?.content.assignees.map((u) => u.login) ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none border-b border-border/60 px-4 py-3">
        <div className="flex items-start gap-2">
          <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-mono">
                {owner}/{repo}#{number}
              </span>
            </div>
            {editingTitle ? (
              <Input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void commitTitle()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditingTitle(false)
                  }
                }}
                className="mt-1 h-8"
              />
            ) : (
              <button
                type="button"
                className="mt-1 text-left text-[15px] font-semibold leading-tight hover:underline"
                onClick={() => {
                  setTitleDraft(title)
                  setEditingTitle(true)
                }}
              >
                {title || 'Untitled'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {url ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void window.api.shell.openUrl(url)}
                aria-label="Open in GitHub"
              >
                <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px]">
          <LabelsEditor
            owner={owner}
            repo={repo}
            selected={labels}
            onChange={async (add, remove) => {
              const res = await patchProjectIssueOrPr(cacheKey, row?.id ?? '', {
                ...(add.length ? { addLabels: add } : {}),
                ...(remove.length ? { removeLabels: remove } : {})
              })
              if (!res.ok) toast.error(res.error.message)
            }}
          />
          <AssigneesEditor
            owner={owner}
            repo={repo}
            selected={assignees}
            onChange={async (add, remove) => {
              const res = await patchProjectIssueOrPr(cacheKey, row?.id ?? '', {
                ...(add.length ? { addAssignees: add } : {}),
                ...(remove.length ? { removeAssignees: remove } : {})
              })
              if (!res.ok) toast.error(res.error.message)
            }}
          />
          {onStartWork ? (
            <Button
              size="sm"
              variant="default"
              className="ml-auto"
              disabled={!startWorkEnabled}
              onClick={onStartWork}
            >
              Start work
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loading && !details ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : details ? (
          <div className="flex flex-col gap-4">
            <section>
              {editingBody ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    autoFocus
                    value={bodyDraft}
                    onChange={(e) => setBodyDraft(e.target.value)}
                    className="min-h-[140px] w-full rounded border border-border/50 bg-background p-2 text-sm"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void commitBody()}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingBody(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : body ? (
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => {
                    setBodyDraft(body)
                    setEditingBody(true)
                  }}
                >
                  <CommentMarkdown content={body} variant="document" />
                </button>
              ) : (
                <button
                  type="button"
                  className="text-xs italic text-muted-foreground hover:underline"
                  onClick={() => {
                    setBodyDraft('')
                    setEditingBody(true)
                  }}
                >
                  Add a description…
                </button>
              )}
            </section>
            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Comments
              </h3>
              <CommentsList
                owner={owner}
                repo={repo}
                comments={details.comments}
                onChange={(next) => setDetails((d) => (d ? { ...d, comments: next } : d))}
              />
              <NewCommentForm
                owner={owner}
                repo={repo}
                number={number}
                onAdded={(c) =>
                  setDetails((d) => (d ? { ...d, comments: [...d.comments, c] } : d))
                }
              />
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LabelsEditor({
  owner,
  repo,
  selected,
  onChange
}: {
  owner: string
  repo: string
  selected: string[]
  onChange: (add: string[], remove: string[]) => void | Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.api.gh
      .listLabelsBySlug({ owner, repo })
      .then((res) => {
        if (res.ok) setOptions(res.labels)
      })
      .finally(() => setLoading(false))
  }, [open, owner, repo])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-md border border-border/50 bg-muted/30 px-2 py-0.5 text-[11px] hover:bg-muted"
        >
          Labels: {selected.length === 0 ? 'none' : selected.join(', ')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {loading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
        ) : (
          options.map((name) => {
            const isOn = selected.includes(name)
            return (
              <button
                key={name}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                onClick={() => {
                  if (isOn) void onChange([], [name])
                  else void onChange([name], [])
                }}
              >
                <span className={cn('inline-block size-2 rounded-full', isOn ? 'bg-primary' : 'bg-muted-foreground/40')} />
                {name}
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}

function AssigneesEditor({
  owner,
  repo,
  selected,
  onChange
}: {
  owner: string
  repo: string
  selected: string[]
  onChange: (add: string[], remove: string[]) => void | Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [users, setUsers] = useState<GitHubAssignableUser[]>([])
  const [loading, setLoading] = useState(false)
  // Why: stabilize the assignee seed identity. `selected` is a fresh array on
  // every parent render — depending on it directly would refire the IPC for
  // every unrelated re-render while the popover is open.
  const seedKey = useMemo(() => selected.slice().sort().join(','), [selected])
  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.api.gh
      .listAssignableUsersBySlug({
        owner,
        repo,
        seedLogins: seedKey ? seedKey.split(',') : []
      })
      .then((res) => {
        if (res.ok) setUsers(res.users)
      })
      .finally(() => setLoading(false))
  }, [open, owner, repo, seedKey])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-md border border-border/50 bg-muted/30 px-2 py-0.5 text-[11px] hover:bg-muted"
        >
          Assignees: {selected.length === 0 ? 'none' : selected.join(', ')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        {loading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
        ) : (
          users.map((u) => {
            const isOn = selected.includes(u.login)
            return (
              <button
                key={u.login}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                onClick={() => {
                  if (isOn) void onChange([], [u.login])
                  else void onChange([u.login], [])
                }}
              >
                <span
                  className={cn(
                    'inline-block size-2 rounded-full',
                    isOn ? 'bg-primary' : 'bg-muted-foreground/40'
                  )}
                />
                {u.avatarUrl ? (
                  <img src={u.avatarUrl} alt="" className="size-4 rounded-full" />
                ) : null}
                {u.login}
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}

function CommentsList({
  owner,
  repo,
  comments,
  onChange
}: {
  owner: string
  repo: string
  comments: PRComment[]
  onChange: (next: PRComment[]) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {comments.length === 0 ? (
        <div className="text-xs italic text-muted-foreground">No comments yet.</div>
      ) : (
        comments.map((c) => (
          <CommentRow
            key={c.id}
            owner={owner}
            repo={repo}
            comment={c}
            onDelete={async () => {
              const res = await window.api.gh.deleteIssueCommentBySlug({
                owner,
                repo,
                commentId: c.id
              })
              if (!res.ok) {
                toast.error(res.error.message)
                return
              }
              onChange(comments.filter((x) => x.id !== c.id))
            }}
            onEdit={async (next) => {
              const res = await window.api.gh.updateIssueCommentBySlug({
                owner,
                repo,
                commentId: c.id,
                body: next
              })
              if (!res.ok) {
                toast.error(res.error.message)
                return
              }
              onChange(comments.map((x) => (x.id === c.id ? { ...x, body: next } : x)))
            }}
          />
        ))
      )}
    </div>
  )
}

function CommentRow({
  comment,
  onDelete,
  onEdit
}: {
  owner: string
  repo: string
  comment: PRComment
  onDelete: () => void | Promise<void>
  onEdit: (next: string) => void | Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  return (
    <div className="rounded border border-border/50 bg-muted/20 p-3">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{comment.author}</span>
        <div className="flex gap-2">
          <button type="button" className="hover:underline" onClick={() => { setDraft(comment.body); setEditing(true) }}>
            Edit
          </button>
          <button type="button" className="hover:underline" onClick={() => void onDelete()}>
            Delete
          </button>
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[80px] w-full rounded border border-border/50 bg-background p-2 text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setEditing(false)
                void onEdit(draft)
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <CommentMarkdown content={comment.body} />
      )}
    </div>
  )
}

function NewCommentForm({
  owner,
  repo,
  number,
  onAdded
}: {
  owner: string
  repo: string
  number: number
  onAdded: (c: PRComment) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Write a comment…"
        className="min-h-[80px] w-full rounded border border-border/50 bg-background p-2 text-sm"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!draft.trim() || submitting}
          onClick={async () => {
            const body = draft.trim()
            if (!body) return
            setSubmitting(true)
            try {
              const res = await window.api.gh.addIssueCommentBySlug({ owner, repo, number, body })
              if (!res.ok) {
                toast.error(res.error.message)
                return
              }
              onAdded(res.comment)
              setDraft('')
            } finally {
              setSubmitting(false)
            }
          }}
        >
          <Send className="mr-1 size-3.5" /> Comment
        </Button>
      </div>
    </div>
  )
}
