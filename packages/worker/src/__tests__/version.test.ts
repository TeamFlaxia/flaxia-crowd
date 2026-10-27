import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const TEST_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'

describe('worker version endpoints', () => {
  it('preserves the health body and includes build metadata in headers', async () => {
    const response = await SELF.fetch('https://crowd.test/health')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')
    expect(response.headers.get('x-worker-version')).toBe('test-version')
    expect(response.headers.get('x-worker-commit')).toBe(TEST_COMMIT_SHA)
  })

  it('returns build metadata from /version', async () => {
    const response = await SELF.fetch('https://crowd.test/version')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      service: 'flaxia-worker',
      version: 'test-version',
      commit: TEST_COMMIT_SHA,
    })
  })
})
