import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ExternalLink, X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import type { ConnectionState } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobileGitStatusResult } from '../../source-control/mobile-git-status'
import {
  useMobilePrSidebarController,
  type MobilePrSidebarController
} from '../../session/use-mobile-pr-sidebar-controller'
import { MobilePRSidebar } from '../MobilePRSidebar'
import { openMobilePrUrl } from '../MobilePrComposeSheet'

type BodyProps = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  branch: string | null
  headSha: string | null
  gitStatus: MobileGitStatusResult | null
  isGithubRepo?: boolean
  branchContextLoaded?: boolean
  controller: MobilePrSidebarController
  // 'chromeless' drops the panel's own header + SafeAreaView so it can live inside
  // the source-control hub, which owns the header, segmented control, and chrome.
  chromeless?: boolean
  // When false, the parent (the hub) owns triggering the initial load — the body
  // must not also fire it, or a ?tab=pr deep link double-fetches. Default true so
  // the standalone route stays self-loading.
  autoLoad?: boolean
  embedded?: boolean
  onRequestClose?: () => void
}

type Props = Omit<BodyProps, 'controller' | 'autoLoad'>

// Standalone entry (the /pr route + wide-layout dock): owns its controller and
// self-loads. The hub uses MobilePrViewPanelBody with a shared controller instead.
export function MobilePrViewPanel(props: Props) {
  const controller = useMobilePrSidebarController({
    client: props.client,
    connState: props.connState,
    worktreeId: props.worktreeId,
    branch: props.branch,
    headSha: props.headSha
  })
  return <MobilePrViewPanelBody {...props} controller={controller} />
}

export function MobilePrViewPanelBody({
  client,
  connState,
  worktreeId,
  branch,
  headSha,
  gitStatus,
  isGithubRepo = true,
  branchContextLoaded = true,
  controller,
  chromeless = false,
  autoLoad = true,
  embedded = false,
  onRequestClose
}: BodyProps) {
  const router = useRouter()
  const insets = useSafeAreaInsets()

  // A docked/full-screen PR panel is always visible — there is no drawer to open,
  // so trigger the load directly once context is ready rather than gating on the
  // showPRSidebar overlay flag (KTD4). Skipped when the hub owns the trigger.
  const prSidebarKind = controller.prSidebarState.kind
  const refetch = controller.refetchPRSidebar
  useEffect(() => {
    if (autoLoad && branch && isGithubRepo && prSidebarKind === 'hidden') {
      refetch()
    }
  }, [autoLoad, branch, isGithubRepo, prSidebarKind, refetch])

  // Embedded: the dock column applies the bottom inset; full-screen relies on its own
  // SafeAreaView (edges top only), so content must clear the home indicator itself.
  const sidebarState = !branchContextLoaded
    ? ({ kind: 'loading' } as const)
    : !isGithubRepo
      ? ({
          kind: 'blocked',
          message: 'Hosted review panel unavailable for this provider.'
        } as const)
      : branch === null
        ? ({
            kind: 'error',
            message: 'Current branch unavailable.'
          } as const)
        : controller.prSidebarState
  // Why: open-on-host lives in the chrome so the PR URL is always flush-right of
  // the screen title, even when the body is scrolled past the PR header.
  const prUrl =
    sidebarState.kind === 'ready' && sidebarState.data.pr.url ? sidebarState.data.pr.url : null
  const prNumber = sidebarState.kind === 'ready' ? sidebarState.data.pr.number : null
  const openPr = prUrl ? () => openMobilePrUrl(prUrl) : undefined
  const openPrControl = openPr ? (
    <Pressable
      style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
      onPress={openPr}
      hitSlop={8}
      accessibilityRole="link"
      accessibilityLabel={
        prNumber != null
          ? `Open pull request #${prNumber} on the web`
          : 'Open pull request on the web'
      }
    >
      <ExternalLink size={18} color={colors.textSecondary} strokeWidth={2.2} />
    </Pressable>
  ) : null
  const sidebar = (
    <MobilePRSidebar
      state={sidebarState}
      onRetry={controller.retryPRSidebar}
      refetch={controller.refetchPRSidebar}
      client={client}
      connState={connState}
      worktreeId={worktreeId}
      gitBranch={branch}
      gitStatus={gitStatus}
      headSha={headSha}
      bottomInset={insets.bottom}
    />
  )

  // Chromeless: the hub owns the header + chrome, so render just the scrollable body.
  if (chromeless) {
    return <View style={styles.container}>{sidebar}</View>
  }

  if (embedded) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.topBar}>
            <Pressable
              style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
              onPress={onRequestClose}
              hitSlop={8}
              accessibilityLabel="Close pull request panel"
            >
              <X size={20} color={colors.textSecondary} strokeWidth={2.2} />
            </Pressable>
            <Text style={styles.title} numberOfLines={1}>
              Pull Request
            </Text>
            {openPrControl}
          </View>
        </View>
        {sidebar}
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityLabel="Back to session"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            Pull Request
          </Text>
          {openPrControl}
        </View>
      </View>
      {sidebar}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  topBar: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600'
  }
})
