/**
 * Shared helpers for the plugin's local HTTP surfaces: the loopback shim and
 * the same-origin web-status route. Both are only ever meant to be addressed
 * through the machine's loopback interface.
 *
 * Two things live here because both are about that surface: the inbound gates
 * that keep a request on loopback, and the port selection that keeps the shim
 * reachable through fetch once it is up.
 *
 * @module dsh-workbuddy-connect/loopback
 */

import type { AddressInfo } from 'node:net'

/** Loopback hostnames a local plugin surface may be addressed by. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  // Only `name:port` with a single colon is a port; anything with more colons
  // is an (unbracketed) IPv6 literal and must not be truncated.
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
 * Host, so this check drops those before any routing happens.
 */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser
 * clients (the plugin's own fetch calls) send no Origin at all and pass.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Ports fetch refuses to connect to, per the fetch standard's port blocking
 * table (https://fetch.spec.whatwg.org/#port-blocking). Kept in sync with the
 * `badPorts` table undici ships: only the entries a host's ephemeral range can
 * actually reach matter, but carrying the whole list costs nothing and keeps
 * the check honest on machines with a customised range.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
])

/** Whether fetch (and therefore pi-ai) refuses to connect to `port`. */
export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port)
}

/**
 * The slice of `node:http`'s `Server` the bind helper touches. Narrowed so
 * tests can drive the retry path with a fake instead of hoping the OS picks a
 * blocked port.
 */
export interface PortBindableServer {
  listen(port: number, host: string): unknown
  address(): AddressInfo | string | null
  once(event: 'listening', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'listening', listener: () => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  close(callback: () => void): unknown
  closeAllConnections(): void
}

/** Bind attempts allowed before giving up, including the first. */
const DEFAULT_MAX_ATTEMPTS = 16

export interface BindToUsablePortOptions {
  /** Interface to bind. The plugin's surfaces are loopback-only. */
  host: string
  /** Bind attempts allowed before giving up, including the first. */
  maxAttempts?: number
  /**
   * Which ports to reject. Defaults to {@link isFetchBlockedPort}; overridable
   * because a test cannot make the OS hand out a specific port.
   */
  isPortBlocked?: (port: number) => boolean
  /** Called once per rejected port, before rebinding, for diagnostics. */
  onBlockedPort?: (port: number, attempt: number) => void
}

/**
 * Bind `server` to an ephemeral port fetch will actually connect to, and
 * resolve with the address it ended up on.
 *
 * `listen(0)` lets the OS hand out any free ephemeral port, and a handful of
 * the ports it can hand out are on the fetch standard's bad-port list: fetch
 * refuses to connect to them and fails with `TypeError: fetch failed` before a
 * socket is opened. The shim is only ever reached through fetch (pi-ai calls
 * it), so settling on one of those ports leaves the plugin with an endpoint
 * that answers raw HTTP and rejects every real request. The port is not
 * negotiable at request time, so the only fix is to bind again.
 *
 * A blocked port is closed and rebound; a listen error is fatal, as it was
 * before, because nothing about picking another port would fix it.
 */
export async function bindToUsablePort(
  server: PortBindableServer,
  options: BindToUsablePortOptions,
): Promise<AddressInfo> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const isPortBlocked = options.isPortBlocked ?? isFetchBlockedPort
  let lastBlockedPort = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const address = await listenOnEphemeralPort(server, options.host)
    if (!isPortBlocked(address.port)) return address
    lastBlockedPort = address.port
    options.onBlockedPort?.(address.port, attempt)
    await closeQuietly(server)
  }
  throw new Error(
    `could not bind a fetch-reachable loopback port after ${maxAttempts} attempts `
    + `(last blocked port: ${lastBlockedPort})`,
  )
}

/** One `listen(0)` on `host`, resolving with the address the OS handed out. */
function listenOnEphemeralPort(server: PortBindableServer, host: string): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    // Settle with both listeners detached: `close()` hangs its own `error`
    // listener on the same server, and a leftover one here would swallow it.
    const cleanup = (): void => {
      server.off('listening', onListening)
      server.off('error', onError)
    }
    const onListening = (): void => {
      cleanup()
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('workbuddy shim has no listening address'))
        return
      }
      resolve(address)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(0, host)
  })
}

/** Close between attempts; a listener that already closed is not an error here. */
function closeQuietly(server: PortBindableServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}
