import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  fetchMobileGitHistory,
  mapMobileCommitRows,
  type MobileCommitRow
} from './mobile-git-history'
import type { GitBranchChangeEntry } from '../../../src/shared/types'

type Props = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  bottomInset: number
}

// Headerless commit-history list. Extracted from the /history route so the hub's
// History segment and the standalone route render the same body over one code path.
export function MobileGitHistoryList({ client, connState, worktreeId, bottomInset }: Props) {
  const [rows, setRows] = useState<MobileCommitRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesById, setFilesById] = useState<Record<string, GitBranchChangeEntry[] | 'loading'>>({})

  useEffect(() => {
    let active = true
    if (!client || connState !== 'connected' || !worktreeId) {
      return
    }
    // Reset prior error/rows so a successful retry doesn't stay stuck behind a
    // stale error (error wins render precedence).
    setError(null)
    setRows(null)
    void (async () => {
      try {
        const result = await fetchMobileGitHistory(client, worktreeId)
        if (active) {
          setRows(mapMobileCommitRows(result, Date.now()))
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load history')
        }
      }
    })()
    return () => {
      active = false
    }
  }, [client, connState, worktreeId])

  const toggleCommit = useCallback(
    (row: MobileCommitRow) => {
      const next = expanded === row.id ? null : row.id
      setExpanded(next)
      if (next && client && !filesById[row.id]) {
        setFilesById((prev) => ({ ...prev, [row.id]: 'loading' }))
        void client
          .sendRequest('git.commitCompare', { worktree: `id:${worktreeId}`, commitId: row.id })
          .then((response) => {
            const entries = response.ok
              ? ((response as RpcSuccess).result as { entries: GitBranchChangeEntry[] }).entries
              : []
            setFilesById((prev) => ({ ...prev, [row.id]: entries }))
          })
          .catch(() => setFilesById((prev) => ({ ...prev, [row.id]: [] })))
      }
    },
    [client, expanded, filesById, worktreeId]
  )

  const renderCommit = useCallback(
    ({ item }: { item: MobileCommitRow }) => {
      const files = filesById[item.id]
      const isOpen = expanded === item.id
      return (
        <View style={styles.commit}>
          <Pressable
            style={({ pressed }) => [styles.commitHeader, pressed && styles.commitHeaderPressed]}
            onPress={() => toggleCommit(item)}
          >
            {isOpen ? (
              <ChevronDown size={14} color={colors.textMuted} />
            ) : (
              <ChevronRight size={14} color={colors.textMuted} />
            )}
            <View style={styles.commitMain}>
              <Text style={styles.commitSubject} numberOfLines={1}>
                {item.subject}
              </Text>
              <Text style={styles.commitMeta} numberOfLines={1}>
                {item.shortId} · {item.author} · {item.relativeTime}
              </Text>
            </View>
          </Pressable>
          {isOpen ? (
            <View style={styles.files}>
              {files === 'loading' || files === undefined ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : files.length === 0 ? (
                <Text style={styles.empty}>No file changes</Text>
              ) : (
                files.map((file) => (
                  <View key={file.path} style={styles.fileRow}>
                    <Text style={styles.filePath} numberOfLines={1}>
                      {file.path}
                    </Text>
                    <Text style={styles.fileStat}>
                      {file.added ? <Text style={styles.add}>+{file.added} </Text> : null}
                      {file.removed ? <Text style={styles.del}>-{file.removed}</Text> : null}
                    </Text>
                  </View>
                ))
              )}
            </View>
          ) : null}
        </View>
      )
    },
    [expanded, filesById, toggleCommit]
  )

  if (error) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>{error}</Text>
      </View>
    )
  }
  if (rows === null) {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (rows.length === 0) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>No commits.</Text>
      </View>
    )
  }
  return (
    <FlatList
      data={rows}
      renderItem={renderCommit}
      keyExtractor={(row) => row.id}
      contentContainerStyle={{ paddingBottom: spacing.lg + bottomInset }}
    />
  )
}

const styles = StyleSheet.create({
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  stateText: { color: colors.textMuted, fontSize: typography.bodySize },
  commit: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  commitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  commitHeaderPressed: { backgroundColor: colors.bgRaised },
  commitMain: { flex: 1, minWidth: 0 },
  commitSubject: { color: colors.textPrimary, fontSize: typography.bodySize },
  commitMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    marginTop: 2
  },
  files: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 4 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  filePath: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  fileStat: { fontSize: typography.metaSize, fontFamily: typography.monoFamily },
  add: { color: colors.gitDecorationAdded },
  del: { color: colors.gitDecorationDeleted },
  empty: { color: colors.textMuted, fontSize: typography.metaSize }
})
