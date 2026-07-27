import { describe, expect, it } from 'vitest'
import { isHttpUrl, isPrivateHost, isReachableFrom } from '../../src/main/documents/hosts'

describe('isPrivateHost', () => {
  it.each([
    'localhost',
    'app.localhost',
    'printer.local',
    'db.internal',
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    'intranet', // no dots — a LAN name
  ])('treats %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  it.each([
    'example.com',
    'blog.cloudflare.com',
    '8.8.8.8',
    '172.32.0.1', // just outside RFC1918
    '172.15.0.1',
    '11.0.0.1',
    '2606:4700::1111',
  ])('treats %s as public', (host) => {
    expect(isPrivateHost(host)).toBe(false)
  })

  it('ignores case and IPv6 brackets', () => {
    expect(isPrivateHost('LOCALHOST')).toBe(true)
    expect(isPrivateHost('[::1]')).toBe(true)
  })
})

describe('isHttpUrl', () => {
  it('accepts only http and https', () => {
    expect(isHttpUrl(new URL('https://example.com'))).toBe(true)
    expect(isHttpUrl(new URL('http://example.com'))).toBe(true)
    expect(isHttpUrl(new URL('file:///etc/passwd'))).toBe(false)
    expect(isHttpUrl(new URL('data:text/html,x'))).toBe(false)
  })
})

describe('isReachableFrom', () => {
  const publicPage = new URL('https://example.com/post')
  const localPage = new URL('http://localhost:3000/post')

  it('lets a public page reach public hosts', () => {
    expect(isReachableFrom(new URL('https://cdn.test/a.png'), publicPage)).toBe(true)
  })

  it('stops a public page reaching into private space', () => {
    expect(isReachableFrom(new URL('http://192.168.1.1/admin'), publicPage)).toBe(false)
    expect(isReachableFrom(new URL('http://169.254.169.254/latest/meta-data/'), publicPage)).toBe(
      false,
    )
  })

  it('lets a page clipped from private space keep its own assets', () => {
    expect(isReachableFrom(new URL('http://localhost:3000/img/a.png'), localPage)).toBe(true)
  })

  it('rejects non-http schemes regardless of origin', () => {
    expect(isReachableFrom(new URL('file:///etc/passwd'), localPage)).toBe(false)
  })
})
