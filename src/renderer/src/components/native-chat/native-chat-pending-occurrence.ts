import { stripImagePromptMarker } from './native-chat-image-transcript-markers'

export type NativeChatPendingOccurrence = {
  text: string
  sentAt: number
  afterMessageId?: string | null
  matchingOccurrence?: number
  matchingAfterTimestamp?: number
}

export function normalizeNativeChatPendingText(text: string): string {
  return stripImagePromptMarker(text).trim().replace(/\s+/g, ' ')
}

export function nativeChatPendingMatchKey(pending: NativeChatPendingOccurrence): string {
  return `${String(pending.afterMessageId)}\0${normalizeNativeChatPendingText(pending.text)}`
}

export function assignNativeChatPendingOccurrence<T extends NativeChatPendingOccurrence>(
  existing: readonly T[],
  entry: T
): T {
  const key = nativeChatPendingMatchKey(entry)
  const matching = existing.filter((candidate) => nativeChatPendingMatchKey(candidate) === key)
  if (matching.length === 0) {
    return entry
  }
  const previousOccurrence = Math.max(
    ...matching.map((candidate, index) => candidate.matchingOccurrence ?? index + 1)
  )
  const first = matching[0]
  // Why: pruning an earlier echo must not let a later identical send reuse the
  // same transcript occurrence, even after the read pages out its boundary.
  return {
    ...entry,
    matchingOccurrence: previousOccurrence + 1,
    matchingAfterTimestamp: first?.matchingAfterTimestamp ?? first?.sentAt
  }
}

export function nativeChatPendingMatchingAfter(pending: NativeChatPendingOccurrence): number {
  return pending.matchingAfterTimestamp ?? pending.sentAt
}

export function nativeChatPendingOccurrence(
  pending: NativeChatPendingOccurrence,
  alreadyConsumed: number
): number {
  return pending.matchingOccurrence ?? alreadyConsumed + 1
}
