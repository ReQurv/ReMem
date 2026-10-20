import { describe, expect, test } from 'bun:test'

import { ConfigError } from '../../src/errors'
import { TenantRegistry } from '../../src/mcp/tenants'

const VALID = JSON.stringify([
  { key: 'rk_alice', name: 'alice', tenant: 'acme-alice', company: 'acme-corp', role: 'user' },
  { key: 'rk_ops', name: 'ops-bot', tenant: 'acme-ops', company: 'acme-corp', role: 'admin' },
])

describe('TenantRegistry', () => {
  test('parses valid principals and resolves keys', () => {
    const reg = new TenantRegistry(VALID)
    expect(reg.size).toBe(2)
    expect(reg.resolve('rk_alice')).toEqual({
      name: 'alice',
      tenant: 'acme-alice',
      company: 'acme-corp',
      role: 'user',
    })
    expect(reg.resolve('rk_ops')?.role).toBe('admin')
    expect(reg.resolve('rk_unknown')).toBeNull()
    expect(reg.resolve(undefined)).toBeNull()
    expect(reg.resolve(null)).toBeNull()
    expect(reg.resolve('')).toBeNull()
  })

  test('rejects non-JSON / non-array / empty input', () => {
    expect(() => new TenantRegistry('not json')).toThrow(ConfigError)
    expect(() => new TenantRegistry('{"key":"x"}')).toThrow(ConfigError)
    expect(() => new TenantRegistry('[]')).toThrow(ConfigError)
  })

  test('rejects malformed entries', () => {
    expect(() => new TenantRegistry('[{"key":"","name":"a","tenant":"t","company":"c","role":"user"}]')).toThrow(
      ConfigError,
    )
    expect(() => new TenantRegistry('[{"key":"k","name":"a","tenant":"t","company":"c","role":"superuser"}]')).toThrow(
      ConfigError,
    )
    expect(() => new TenantRegistry('[{"key":"k","name":"a","tenant":"t","role":"user"}]')).toThrow(ConfigError)
    expect(() => new TenantRegistry('[{"name":"a","tenant":"t","company":"c","role":"user"}]')).toThrow(ConfigError)
  })

  test('rejects duplicate API keys', () => {
    const dup = JSON.stringify([
      { key: 'rk_x', name: 'a', tenant: 't', company: 'c', role: 'user' },
      { key: 'rk_x', name: 'b', tenant: 't2', company: 'c', role: 'user' },
    ])
    expect(() => new TenantRegistry(dup)).toThrow(ConfigError)
  })

  test('fromEnv reads MCP_USERS and fails when missing', () => {
    expect(() => TenantRegistry.fromEnv({} as NodeJS.ProcessEnv)).toThrow(ConfigError)
    expect(() => TenantRegistry.fromEnv({ MCP_USERS: '   ' } as NodeJS.ProcessEnv)).toThrow(ConfigError)
    const reg = TenantRegistry.fromEnv({ MCP_USERS: VALID } as NodeJS.ProcessEnv)
    expect(reg.size).toBe(2)
  })
})
