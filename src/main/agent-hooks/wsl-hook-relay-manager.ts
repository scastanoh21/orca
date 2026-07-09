// Host-side lifecycle manager for the guest-resident WSL agent-hook relay
// (STA-1515). One relay per distro per Orca instance, ensured from every WSL
// PTY spawn (fresh spawns AND post-restart reattach re-spawns), forwarding
// guest hook envelopes into agentHookServer.ingestRemote and installing hook
// configs into the guest over the relay's fs bridge.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { installWslGuestHooks } from './wsl-hook-fs-adapter'
import {
  buildGuestInstallScript,
  buildWslRelaySpawnEnv,
  formatWslRelayFailure,
  type WslRelayStartupFailure
} from './wsl-hook-relay-launch'
import { defaultWslHookRelayDeps, type WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import { wireWslRelayLink } from './wsl-hook-relay-link'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_REQUEST_REPLAY_METHOD } from '../../shared/agent-hook-relay'
import {
  WSL_HOOK_FS_METHODS,
  WSL_HOOK_RELAY_NO_NODE_EXIT_CODE,
  wslHookRelayEndpointFilePath
} from '../../shared/wsl-hook-relay-contract'

export type { WslHookRelayManagerDeps } from './wsl-hook-relay-deps'

const TRANSIENT_RETRY_LIMIT = 2
const FAILURE_COOLDOWN_BASE_MS = 60_000
const FAILURE_COOLDOWN_MAX_MS = 10 * 60_000
// Why: a distro without node >= 18 will not grow one mid-session; probe
// rarely instead of once per PTY spawn.
const NO_NODE_COOLDOWN_MS = 10 * 60_000
// Why: a previously-healthy relay dying mid-session (mux protocol error, WSL
// restart) must self-recover — a live agent session produces no new PTY
// spawns, so waiting for the next ensure would leave status dead for good.
const RUNNING_TEARDOWN_COOLDOWN_MS = 10_000
// Why: re-running the (byte-equality idempotent) installers on later spawns
// picks up configs that appeared after first install — e.g. Codex's runtime
// home config.toml is seeded by the launch path, so its hook-trust entries
// can only be written once that file exists. Throttled: cheap but not free.
const REINSTALL_MIN_INTERVAL_MS = 30_000

type DistroState = {
  phase: 'starting' | 'running' | 'failed'
  child?: ChildProcessWithoutNullStreams
  mux?: SshChannelMultiplexer
  guestHome?: string
  guestEndpointFilePath?: string
  failures: number
  cooldownUntil: number
  restartTimer?: ReturnType<typeof setTimeout>
  lastInstallAt?: number
}

export class WslHookRelayManager {
  private deps: WslHookRelayManagerDeps
  private states = new Map<string, DistroState>()
  private defaultDistro: string | null = null
  private disposed = false

  constructor(deps: Partial<WslHookRelayManagerDeps> = {}) {
    this.deps = { ...defaultWslHookRelayDeps, ...deps }
  }

  /** Fire-and-forget: called from every WSL PTY spawn-env build. Errors are
   *  breadcrumbed, never thrown — hooks degrade, terminals must not. */
  ensureForDistro(distro: string | null): void {
    if (this.disposed || this.deps.platform() !== 'win32' || !this.deps.remoteHooksEnabled()) {
      return
    }
    void this.ensureInternal(distro).catch((err) => {
      this.deps.warn(
        `[agent-hooks] WSL hook relay ensure failed: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  /** Guest-side endpoint file path for a distro's PTY env, once known.
   *  Null before the relay's first connect — callers keep the /p-translated
   *  Windows endpoint path until then. */
  getGuestEndpointFilePath(distro: string | null): string | null {
    const key = distro ?? this.defaultDistro
    if (!key) {
      return null
    }
    return this.states.get(key)?.guestEndpointFilePath ?? null
  }

  disposeAll(): void {
    this.disposed = true
    for (const state of this.states.values()) {
      if (state.restartTimer) {
        clearTimeout(state.restartTimer)
      }
      state.mux?.dispose()
      state.child?.kill()
    }
    this.states.clear()
  }

  private async ensureInternal(requestedDistro: string | null): Promise<void> {
    const distro = requestedDistro ?? (await this.resolveDefaultDistro())
    if (!distro || this.disposed) {
      return
    }
    const existing = this.states.get(distro)
    if (existing) {
      if (existing.phase === 'running') {
        void this.maybeReinstallHooks(distro, existing)
        return
      }
      if (existing.phase !== 'failed' || Date.now() < existing.cooldownUntil) {
        return
      }
    }
    const coords = this.deps.hookCoordsEnv()
    const port = Number(coords.ORCA_AGENT_HOOK_PORT ?? '')
    if (!Number.isInteger(port) || port <= 0 || !coords.ORCA_AGENT_HOOK_TOKEN) {
      return
    }
    const bundle = this.deps.resolveBundle()
    if (!bundle) {
      this.deps.warn('[agent-hooks] WSL hook relay bundle not found; run build:relay')
      return
    }
    if (existing?.restartTimer) {
      clearTimeout(existing.restartTimer)
    }
    const state: DistroState = {
      phase: 'starting',
      failures: existing?.failures ?? 0,
      cooldownUntil: 0
    }
    this.states.set(distro, state)

    const env = buildWslRelaySpawnEnv(coords, bundle.version)

    try {
      await this.launchWithInstall(distro, state, env, bundle.jsPath, bundle.version, port)
    } catch (err) {
      // Why: the teardown handler may have already recorded this failure
      // (child died mid-connect); don't double-count it.
      if (state.phase !== 'failed') {
        this.markFailed(
          distro,
          state,
          err instanceof Error ? err.message : String(err),
          FAILURE_COOLDOWN_BASE_MS
        )
      }
    }
  }

  private async launchWithInstall(
    distro: string,
    state: DistroState,
    env: NodeJS.ProcessEnv,
    bundleJsPath: string,
    version: string,
    windowsPort: number
  ): Promise<void> {
    let installTried = false
    let transientRetries = 0
    for (;;) {
      const child = this.deps.spawnRelay(distro, env)
      state.child = child
      try {
        const transport = await this.deps.waitForSentinel(child)
        await this.connect(distro, state, transport, child, windowsPort)
        return
      } catch (err) {
        const failure = (err as { startup?: WslRelayStartupFailure }).startup
        if (!failure) {
          throw err
        }
        if (failure.code === WSL_HOOK_RELAY_NO_NODE_EXIT_CODE) {
          this.markFailed(
            distro,
            state,
            `no node >= 18 found in distro '${distro}'; agent hooks stay degraded there`,
            NO_NODE_COOLDOWN_MS
          )
          return
        }
        // Why: fresh WSL intermittently throws "Catastrophic failure
        // (E_UNEXPECTED)" under concurrent wsl.exe spawn load; bounded retry,
        // never a spawn loop.
        if (
          /catastrophic failure/i.test(failure.stderr) &&
          transientRetries < TRANSIENT_RETRY_LIMIT
        ) {
          transientRetries++
          await new Promise((resolve) => setTimeout(resolve, this.deps.transientRetryDelayMs))
          continue
        }
        if (!installTried) {
          installTried = true
          const script = buildGuestInstallScript(this.deps.readBundle(bundleJsPath), version)
          const result = await this.deps.runInstall(distro, script, env)
          if (result.code === 0) {
            continue
          }
          this.markFailed(
            distro,
            state,
            `guest install failed (code ${result.code ?? 'unknown'}): ${result.stderr.trim()}`,
            FAILURE_COOLDOWN_BASE_MS
          )
          return
        }
        this.markFailed(distro, state, formatWslRelayFailure(failure), FAILURE_COOLDOWN_BASE_MS)
        return
      }
    }
  }

  private async connect(
    distro: string,
    state: DistroState,
    transport: MultiplexerTransport,
    child: ChildProcessWithoutNullStreams,
    windowsPort: number
  ): Promise<void> {
    const mux = new SshChannelMultiplexer(transport)
    state.mux = mux
    wireWslRelayLink({
      mux,
      child,
      distro,
      ingest: this.deps.ingest,
      warn: this.deps.warn,
      onDead: (reason) => {
        if (this.disposed || state.mux !== mux) {
          return
        }
        state.mux = undefined
        const wasRunning = state.phase === 'running'
        this.markFailed(
          distro,
          state,
          `relay link for '${distro}' ${reason}; scheduling restart`,
          wasRunning ? RUNNING_TEARDOWN_COOLDOWN_MS : FAILURE_COOLDOWN_BASE_MS
        )
        this.scheduleRestart(distro, state)
      }
    })

    const homeResult = (await mux.request(WSL_HOOK_FS_METHODS.home)) as {
      ok?: boolean
      home?: string
    }
    if (homeResult?.ok === true && typeof homeResult.home === 'string') {
      state.guestHome = homeResult.home
      state.guestEndpointFilePath = wslHookRelayEndpointFilePath(homeResult.home, windowsPort)
      await this.runInstallers(distro, state, mux, homeResult.home)
    } else {
      this.deps.warn(`[agent-hooks] WSL hook relay for '${distro}' returned no home dir`)
    }

    if (state.phase === 'failed' || state.mux !== mux) {
      // Child died while we were installing — the close handler already
      // recorded the failure; don't revive the state.
      return
    }
    state.phase = 'running'
    state.failures = 0
    void mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD).catch(() => {
      // Fresh relays have nothing to replay; tolerate.
    })
  }

  private async runInstallers(
    distro: string,
    state: DistroState,
    mux: SshChannelMultiplexer,
    guestHome: string
  ): Promise<void> {
    state.lastInstallAt = Date.now()
    await installWslGuestHooks({
      mux,
      guestHome,
      distro,
      installHooks: this.deps.installHooks,
      warn: this.deps.warn
    })
  }

  /** Re-run the byte-equality-idempotent installers on later ensure calls so
   *  configs that appear after first install (e.g. Codex's launch-seeded
   *  runtime-home config.toml) pick up their hook entries. */
  private async maybeReinstallHooks(distro: string, state: DistroState): Promise<void> {
    const mux = state.mux
    const guestHome = state.guestHome
    if (
      !mux ||
      !guestHome ||
      mux.isDisposed() ||
      Date.now() - (state.lastInstallAt ?? 0) < REINSTALL_MIN_INTERVAL_MS
    ) {
      return
    }
    try {
      await this.runInstallers(distro, state, mux, guestHome)
    } catch (err) {
      this.deps.warn(
        `[agent-hooks] WSL hook reinstall for '${distro}' failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private scheduleRestart(distro: string, state: DistroState): void {
    if (this.disposed || state.restartTimer) {
      return
    }
    const delayMs = Math.max(state.cooldownUntil - Date.now(), 0) + 250
    state.restartTimer = setTimeout(() => {
      state.restartTimer = undefined
      this.ensureForDistro(distro)
    }, delayMs)
    state.restartTimer.unref?.()
  }

  private markFailed(
    distro: string,
    state: DistroState,
    message: string,
    cooldownBaseMs: number
  ): void {
    state.phase = 'failed'
    state.failures++
    state.child = undefined
    state.mux = undefined
    state.cooldownUntil =
      Date.now() + Math.min(cooldownBaseMs * state.failures, FAILURE_COOLDOWN_MAX_MS)
    this.deps.warn(`[agent-hooks] WSL hook relay (${distro}): ${message}`)
  }

  private async resolveDefaultDistro(): Promise<string | null> {
    if (this.defaultDistro) {
      return this.defaultDistro
    }
    try {
      const distros = await this.deps.listDistros()
      this.defaultDistro = distros[0] ?? null
    } catch {
      this.defaultDistro = null
    }
    return this.defaultDistro
  }
}

export const wslHookRelayManager = new WslHookRelayManager()
