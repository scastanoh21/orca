// Why: shared validator for the "Share this Orca server" custom address. The
// field accepts a bare host, host:port, or a full ws(s):// URL — looser than
// the mobile pairing grammar because the target is a transport endpoint, not
// just an IP. Kept pure so the renderer and any future caller agree.

export type ParseServerShareAddressResult = { ok: true; value: string } | { ok: false }

// Why: underscores are allowed — the main-process resolver passes arbitrary
// host strings straight through (runtime-rpc.ts parsePairingAddressOverride),
// so internal names like `db_1` must stay advertisable here too.
const HOST_LABEL = '[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?'
const HOSTNAME = `${HOST_LABEL}(?:\\.${HOST_LABEL})*`
const IPV4 = '(?:\\d{1,3}\\.){3}\\d{1,3}'
const HOST = `(?:${HOSTNAME}|${IPV4})`
const PORT = '[0-9]{1,5}'

const HOST_OR_HOST_PORT = new RegExp(`^${HOST}(?::${PORT})?$`)

export function parseServerShareAddress(input: string): ParseServerShareAddressResult {
  const trimmed = input.trim()
  if (trimmed === '' || /\s/.test(trimmed)) {
    return { ok: false }
  }

  // Full ws(s):// URL — defer to the URL parser, which validates host/port/path.
  if (/^wss?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      return url.hostname !== '' ? { ok: true, value: trimmed } : { ok: false }
    } catch {
      return { ok: false }
    }
  }

  // IPv6 literal, bare (`fd7a::1`) or bracketed with optional port
  // (`[fd7a::1]:6768`). The main-process resolver brackets these before use
  // (runtime-rpc.ts resolvePairingEndpoint), so accept them here. Defer to the
  // URL parser by bracketing, which validates the address and any port.
  if (trimmed.includes(':') && !HOST_OR_HOST_PORT.test(trimmed)) {
    const bracketed = trimmed.startsWith('[') ? trimmed : `[${trimmed}]`
    try {
      const url = new URL(`ws://${bracketed}`)
      return url.hostname !== '' ? { ok: true, value: trimmed } : { ok: false }
    } catch {
      return { ok: false }
    }
  }

  // Bare host or host:port. Reject an out-of-range port early.
  const match = trimmed.match(HOST_OR_HOST_PORT)
  if (!match) {
    return { ok: false }
  }
  const portPart = trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : null
  if (portPart !== null && Number(portPart) > 65535) {
    return { ok: false }
  }
  return { ok: true, value: trimmed }
}
