import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  FETCH_BLOCKED_PORTS,
  bindToUsablePort,
  hostIsLoopback,
  hostnameOfHost,
  isFetchBlockedPort,
  originIsLoopback,
  type PortBindableServer,
} from '../src/loopback.ts'

describe('hostnameOfHost', () => {
  it('strips the port from an IPv4 host', () => {
    expect(hostnameOfHost('127.0.0.1:39271')).toBe('127.0.0.1')
  })

  it('keeps an IPv6 host intact without a port', () => {
    expect(hostnameOfHost('[::1]')).toBe('[::1]')
  })

  it('strips the port from a bracketed IPv6 host', () => {
    expect(hostnameOfHost('[::1]:39271')).toBe('[::1]')
  })

  it('does not treat a bare IPv6 literal as host:port', () => {
    expect(hostnameOfHost('::1')).toBe('::1')
  })

  it('lowercases and trims', () => {
    expect(hostnameOfHost('  LocalHost:3080 ')).toBe('localhost')
  })
})

describe('hostIsLoopback', () => {
  it('accepts loopback hosts with and without ports', () => {
    expect(hostIsLoopback('127.0.0.1')).toBe(true)
    expect(hostIsLoopback('localhost:3080')).toBe(true)
    expect(hostIsLoopback('[::1]:3080')).toBe(true)
  })

  it('rejects other hostnames, missing, and empty values', () => {
    expect(hostIsLoopback('evil.example')).toBe(false)
    expect(hostIsLoopback('127.0.0.1.evil.example')).toBe(false)
    expect(hostIsLoopback(undefined)).toBe(false)
    expect(hostIsLoopback('')).toBe(false)
    expect(hostIsLoopback('  ')).toBe(false)
  })
})

describe('originIsLoopback', () => {
  it('passes absent and empty Origins (non-browser clients)', () => {
    expect(originIsLoopback(undefined)).toBe(true)
    expect(originIsLoopback('')).toBe(true)
    expect(originIsLoopback('  ')).toBe(true)
  })

  it('accepts loopback origins', () => {
    expect(originIsLoopback('http://127.0.0.1:3080')).toBe(true)
    expect(originIsLoopback('http://localhost:3080')).toBe(true)
    expect(originIsLoopback('http://[::1]:3080')).toBe(true)
  })

  it('rejects non-loopback and unparsable Origins', () => {
    expect(originIsLoopback('http://evil.example')).toBe(false)
    expect(originIsLoopback('http://127.0.0.1.evil.example')).toBe(false)
    expect(originIsLoopback('not a url')).toBe(false)
  })
})

/**
 * Stand-in for a `node:http` server: hands out ports from a script, and emits
 * `listening`/`error` asynchronously the way the real one does.
 */
class FakeServer implements PortBindableServer {
  readonly boundPorts: number[] = []
  closeCalls = 0
  private index = 0
  private port: number | null = null
  private readonly listening = new Set<() => void>()
  private readonly errors = new Set<(error: Error) => void>()

  constructor(private readonly script: (number | Error)[]) {}

  listen(_port: number, _host: string): void {
    const next = this.script[this.index]
    this.index += 1
    setImmediate(() => {
      if (next === undefined) {
        this.emitError(new Error('no scripted result left'))
        return
      }
      if (next instanceof Error) {
        this.emitError(next)
        return
      }
      this.port = next
      this.boundPorts.push(next)
      for (const listener of [...this.listening]) listener()
    })
  }

  address(): AddressInfo | string | null {
    return this.port === null ? null : { address: '127.0.0.1', family: 'IPv4', port: this.port }
  }

  once(event: 'listening', listener: () => void): void
  once(event: 'error', listener: (error: Error) => void): void
  once(event: 'listening' | 'error', listener: (() => void) | ((error: Error) => void)): void {
    if (event === 'listening') this.listening.add(listener as () => void)
    else this.errors.add(listener as (error: Error) => void)
  }

  off(event: 'listening', listener: () => void): void
  off(event: 'error', listener: (error: Error) => void): void
  off(event: 'listening' | 'error', listener: (() => void) | ((error: Error) => void)): void {
    if (event === 'listening') this.listening.delete(listener as () => void)
    else this.errors.delete(listener as (error: Error) => void)
  }

  close(callback: () => void): void {
    this.closeCalls += 1
    this.port = null
    setImmediate(callback)
  }

  closeAllConnections(): void {}

  /** Live listeners, so a test can prove the bind left none behind. */
  listenerCounts(): { listening: number, error: number } {
    return { listening: this.listening.size, error: this.errors.size }
  }

  private emitError(error: Error): void {
    for (const listener of [...this.errors]) listener(error)
  }
}

describe('FETCH_BLOCKED_PORTS', () => {
  it('covers the ports undici refuses to fetch', () => {
    // The handful of blocked ports a Windows ephemeral range (1024-15000) can
    // actually reach; 10080 is the one observed in the wild.
    for (const port of [1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]) {
      expect(isFetchBlockedPort(port), `port ${port}`).toBe(true)
    }
  })

  it('leaves ordinary ephemeral ports alone', () => {
    for (const port of [1024, 2793, 2794, 10079, 15000, 49152, 65535]) {
      expect(isFetchBlockedPort(port), `port ${port}`).toBe(false)
    }
  })

  it('mirrors the full fetch blocking table', () => {
    // Same 82 entries undici ships; a missing one is a port the shim could
    // settle on and then be unreachable.
    expect(FETCH_BLOCKED_PORTS.size).toBe(82)
    for (const port of [1, 7, 21, 25, 53, 110, 143, 993, 995]) {
      expect(isFetchBlockedPort(port), `port ${port}`).toBe(true)
    }
    // Ordinary service ports fetch does allow must stay allowed.
    for (const port of [2, 80, 443, 1024, 8080]) {
      expect(isFetchBlockedPort(port), `port ${port}`).toBe(false)
    }
  })
})

describe('bindToUsablePort', () => {
  it('resolves on the first port when it is usable', async () => {
    const server = new FakeServer([42000])
    const address = await bindToUsablePort(server, { host: '127.0.0.1' })
    expect(address.port).toBe(42000)
    expect(server.boundPorts).toEqual([42000])
    expect(server.closeCalls).toBe(0)
    expect(server.listenerCounts()).toEqual({ listening: 0, error: 0 })
  })

  it('rebinds away from a blocked port and reports it', async () => {
    const server = new FakeServer([10080, 42001])
    const blocked: [number, number][] = []
    const address = await bindToUsablePort(server, {
      host: '127.0.0.1',
      onBlockedPort: (port, attempt) => blocked.push([port, attempt]),
    })
    expect(address.port).toBe(42001)
    expect(server.boundPorts).toEqual([10080, 42001])
    expect(server.closeCalls).toBe(1)
    expect(blocked).toEqual([[10080, 1]])
    expect(server.listenerCounts()).toEqual({ listening: 0, error: 0 })
  })

  it('keeps rebinding through several blocked ports', async () => {
    const server = new FakeServer([6667, 10080, 4190, 42002])
    const address = await bindToUsablePort(server, { host: '127.0.0.1' })
    expect(address.port).toBe(42002)
    expect(server.closeCalls).toBe(3)
  })

  it('honours a custom blocked-port predicate', async () => {
    const server = new FakeServer([42003, 42004])
    const address = await bindToUsablePort(server, {
      host: '127.0.0.1',
      isPortBlocked: port => port === 42003,
    })
    expect(address.port).toBe(42004)
    expect(server.closeCalls).toBe(1)
  })

  it('rejects when every attempt lands on a blocked port', async () => {
    const server = new FakeServer([10080, 10080, 10080])
    await expect(bindToUsablePort(server, { host: '127.0.0.1', maxAttempts: 3 }))
      .rejects.toThrow(/after 3 attempts \(last blocked port: 10080\)/u)
    expect(server.boundPorts).toEqual([10080, 10080, 10080])
  })

  it('rejects with the listen error rather than retrying it', async () => {
    const failure = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    const server = new FakeServer([failure])
    await expect(bindToUsablePort(server, { host: '127.0.0.1' })).rejects.toThrow(/EADDRINUSE/u)
    expect(server.boundPorts).toEqual([])
    expect(server.listenerCounts()).toEqual({ listening: 0, error: 0 })
  })
})

describe('bindToUsablePort against a real listener', () => {
  it('binds a fetch-reachable port and closes cleanly', async () => {
    const server = createServer()
    const address = await bindToUsablePort(server, { host: '127.0.0.1' })
    expect(address.address).toBe('127.0.0.1')
    expect(isFetchBlockedPort(address.port)).toBe(false)
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })
})
