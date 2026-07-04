import { describe, expect, it } from 'vitest'

import {
  auditBootSecurity,
  formatBootSecurityReport,
  isLoopbackHost,
  type BootSecurityInput,
} from '../src/boot-security.js'

/** A network-exposed input with every defense missing (the worst case). */
function exposed(over: Partial<BootSecurityInput> = {}): BootSecurityInput {
  return {
    host: '0.0.0.0',
    cookieSecure: false,
    allowedHosts: undefined,
    allowInsecure: false,
    ...over,
  }
}

describe('isLoopbackHost (Route B P0-M6)', () => {
  it('treats the whole 127/8 block, ::1 and localhost as loopback', () => {
    for (const h of ['127.0.0.1', '127.0.0.5', '127.10.20.30', '::1', '[::1]', 'localhost']) {
      expect(isLoopbackHost(h)).toBe(true)
    }
    // case + whitespace insensitive
    expect(isLoopbackHost('  LOCALHOST ')).toBe(true)
  })

  it('treats wildcard binds and real addresses/names as exposed', () => {
    for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', '203.0.113.7', 'hub.example.com']) {
      expect(isLoopbackHost(h)).toBe(false)
    }
  })
})

describe('auditBootSecurity (Route B P0-M6)', () => {
  it('a loopback host requires nothing (zero violations even fully undefended)', () => {
    expect(
      auditBootSecurity({
        host: '127.0.0.1',
        cookieSecure: false,
        allowedHosts: undefined,
        allowInsecure: false,
      }),
    ).toEqual([])
  })

  it('an exposed host missing both defenses yields two fatal violations', () => {
    const v = auditBootSecurity(exposed())
    expect(v.map((x) => x.code).sort()).toEqual([
      'cookie_insecure_while_exposed',
      'host_check_disabled_while_exposed',
    ])
    expect(v.every((x) => x.severity === 'fatal')).toBe(true)
  })

  it('an exposed host with both defenses set is clean', () => {
    expect(
      auditBootSecurity(exposed({ allowedHosts: ['hub.example.com'], cookieSecure: true })),
    ).toEqual([])
  })

  it('flags only the missing defense', () => {
    const onlyCookie = auditBootSecurity(exposed({ allowedHosts: ['hub.example.com'] }))
    expect(onlyCookie.map((x) => x.code)).toEqual(['cookie_insecure_while_exposed'])

    const onlyHost = auditBootSecurity(exposed({ cookieSecure: true }))
    expect(onlyHost.map((x) => x.code)).toEqual(['host_check_disabled_while_exposed'])
  })

  it('treats an empty allowedHosts array as unset', () => {
    const v = auditBootSecurity(exposed({ allowedHosts: [], cookieSecure: true }))
    expect(v.map((x) => x.code)).toEqual(['host_check_disabled_while_exposed'])
  })

  it('GOTONG_ALLOW_INSECURE downgrades fatals to warnings (still reported)', () => {
    const v = auditBootSecurity(exposed({ allowInsecure: true }))
    expect(v.length).toBe(2)
    expect(v.every((x) => x.severity === 'warn')).toBe(true)
  })
})

describe('formatBootSecurityReport (Route B P0-M6)', () => {
  it('fatal report names the codes and the escape hatch', () => {
    const report = formatBootSecurityReport(auditBootSecurity(exposed()), { fatal: true })
    expect(report).toContain('FATAL')
    expect(report).toContain('host_check_disabled_while_exposed')
    expect(report).toContain('cookie_insecure_while_exposed')
    expect(report).toContain('GOTONG_ALLOW_INSECURE')
  })

  it('warning report omits the escape-hatch instruction', () => {
    const report = formatBootSecurityReport(auditBootSecurity(exposed({ allowInsecure: true })), {
      fatal: false,
    })
    expect(report).toContain('WARNING')
    expect(report).not.toContain('set GOTONG_ALLOW_INSECURE=1 to downgrade')
  })
})
