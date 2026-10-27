import { describe, expect, it } from 'vitest'
import { originMatchesPattern } from '../origin'

describe('originMatchesPattern', () => {
  it('matches a configured scheme-bound subdomain', () => {
    expect(originMatchesPattern('https://sandbox.flaxia.app', 'https://*.flaxia.app')).toBe(true)
    expect(originMatchesPattern('https://www.flaxia.app', 'https://*.flaxia.app')).toBe(true)
  })

  it('requires the configured scheme and a real subdomain boundary', () => {
    expect(originMatchesPattern('http://sandbox.flaxia.app', 'https://*.flaxia.app')).toBe(false)
    expect(originMatchesPattern('https://flaxia.app', 'https://*.flaxia.app')).toBe(false)
    expect(originMatchesPattern('https://evilflaxia.app', 'https://*.flaxia.app')).toBe(false)
    expect(originMatchesPattern('https://sandbox.flaxia.app.attacker.test', 'https://*.flaxia.app')).toBe(false)
    expect(originMatchesPattern('https://sandbox.flaxia.app:8443', 'https://*.flaxia.app')).toBe(false)
  })

  it('keeps exact origins and host-only wildcard patterns working', () => {
    expect(originMatchesPattern('https://flaxia.app', 'https://flaxia.app')).toBe(true)
    expect(originMatchesPattern('https://sandbox.flaxia.app', '*.flaxia.app')).toBe(true)
    expect(originMatchesPattern('https://elsewhere.test', '*')).toBe(true)
  })
})
