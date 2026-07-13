import { beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { RelayHostHelloAckMessage } from './relay-control-protocol'
import type * as RelayHttpClientModule from './relay-http-client'

const fakes = vi.hoisted(() => ({
  controls: [] as {
    connect: ReturnType<typeof vi.fn>
    closeNow: ReturnType<typeof vi.fn>
  }[],
  transports: [] as {
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    setGeneration: ReturnType<typeof vi.fn>
    metadataFor: ReturnType<typeof vi.fn>
  }[],
  controlConnect: vi.fn(),
  exchange: vi.fn(),
  assign: vi.fn()
}))

vi.mock('./relay-http-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayHttpClientModule>()),
  exchangeRelayAuthorization: fakes.exchange,
  requestRelayAssignment: fakes.assign
}))

vi.mock('./relay-control-client', () => ({
  RelayControlClient: class {
    connect = fakes.controlConnect
    closeNow = vi.fn()

    constructor() {
      fakes.controls.push(this)
    }
  }
}))

vi.mock('../rpc/relay-transport', () => ({
  CloudRelayTransport: class {
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    setGeneration = vi.fn()
    metadataFor = vi.fn()

    constructor() {
      fakes.transports.push(this)
    }
  }
}))

import { RelaySessionBroker, StaleRelayBrokerError } from './relay-session-broker'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('RelaySessionBroker lifecycle ownership', () => {
  beforeEach(() => {
    fakes.controls.length = 0
    fakes.transports.length = 0
    fakes.controlConnect.mockReset()
    fakes.exchange.mockReset().mockResolvedValue({ relayToken: 'relay-jwt', expiresAt: 60_000 })
    fakes.assign.mockReset().mockResolvedValue({
      cellUrl: 'https://relay.example.test',
      assignmentEpoch: 1,
      leaseExpiresAt: 60_000
    })
  })

  it('closes partially opened resources without publishing stale state', async () => {
    const controlAck = deferred<RelayHostHelloAckMessage>()
    fakes.controlConnect.mockReturnValue(controlAck.promise)
    let current = true
    const statuses: string[] = []
    const keypair = nacl.box.keyPair()
    const connecting = RelaySessionBroker.connect({
      authConfig: {
        relayTokenEndpoint: 'https://auth.example.test/v1/relay-token',
        relayDirectorUrl: 'https://relay.example.test'
      } as OrcaCloudAuthConfig,
      accessToken: 'access-token',
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair: {
        ...keypair,
        publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
      },
      appVersion: '1.0.0',
      mobileSocketWiring: { attachTransport: vi.fn() } as never,
      isCurrent: () => current,
      refreshAccessToken: async () => null,
      onStatus: (status) => statuses.push(status),
      onResolveDirector: vi.fn()
    })
    await vi.waitFor(() => expect(fakes.controls).toHaveLength(1))
    current = false
    controlAck.resolve({
      type: 'host-hello-ack',
      v: 1,
      generation: 1,
      controlResumeSecret: 'A'.repeat(43),
      leaseExpiresAt: 60_000,
      activeConnIds: [],
      pendingConns: []
    })

    await expect(connecting).rejects.toBeInstanceOf(StaleRelayBrokerError)
    expect(fakes.controls[0]!.closeNow).toHaveBeenCalledOnce()
    expect(fakes.transports[0]!.stop).toHaveBeenCalledOnce()
    expect(statuses).toEqual(['connecting'])
  })
})
