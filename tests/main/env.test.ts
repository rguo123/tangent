import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnvFiles, parseEnv } from '../../src/main/env'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tangent-env-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeEnv(name: string, contents: string): string {
  const path = join(dir, name)
  writeFileSync(path, contents)
  return path
}

describe('parseEnv', () => {
  it('reads keys, ignoring comments and blank lines', () => {
    expect(
      parseEnv(
        ['# a comment', '', 'ANTHROPIC_API_KEY=sk-ant-123', 'VOYAGE_API_KEY=pa-456'].join('\n'),
      ),
    ).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-123', VOYAGE_API_KEY: 'pa-456' })
  })

  it('tolerates the shapes people actually paste', () => {
    expect(
      parseEnv(
        [
          'export ANTHROPIC_API_KEY=sk-ant-123', // copied from a shell line
          'QUOTED="sk-quoted"', // quotes are not part of the value
          "SINGLE='sk-single'",
          'SPACED  =  sk-spaced  ',
        ].join('\n'),
      ),
    ).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-123',
      QUOTED: 'sk-quoted',
      SINGLE: 'sk-single',
      SPACED: 'sk-spaced',
    })
  })

  it('keeps everything after the first = — keys can contain them', () => {
    expect(parseEnv('TOKEN=abc=def==')).toEqual({ TOKEN: 'abc=def==' })
  })

  it('skips malformed lines rather than throwing', () => {
    expect(parseEnv(['no-separator', '=novalue', 'GOOD=yes'].join('\n'))).toEqual({ GOOD: 'yes' })
  })
})

describe('loadEnvFiles', () => {
  it('applies a file to the environment', () => {
    const env: NodeJS.ProcessEnv = {}
    const path = writeEnv('.env', 'ANTHROPIC_API_KEY=sk-ant-123')

    expect(loadEnvFiles([path], env)).toEqual([{ path, keys: ['ANTHROPIC_API_KEY'] }])
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-123')
  })

  it('never overrides a real environment variable', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'from-the-shell' }
    const path = writeEnv('.env', 'ANTHROPIC_API_KEY=from-the-file\nVOYAGE_API_KEY=pa-456')

    expect(loadEnvFiles([path], env)).toEqual([{ path, keys: ['VOYAGE_API_KEY'] }])
    expect(env.ANTHROPIC_API_KEY).toBe('from-the-shell')
  })

  it('gives the first file that defines a key precedence', () => {
    const env: NodeJS.ProcessEnv = {}
    const first = writeEnv('first.env', 'ANTHROPIC_API_KEY=first')
    const second = writeEnv('second.env', 'ANTHROPIC_API_KEY=second\nVOYAGE_API_KEY=pa-456')

    loadEnvFiles([first, second], env)

    expect(env.ANTHROPIC_API_KEY).toBe('first')
    expect(env.VOYAGE_API_KEY).toBe('pa-456')
  })

  it('treats a missing file as normal — most installs have none', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(loadEnvFiles([join(dir, 'nope.env')], env)).toEqual([])
    expect(env).toEqual({})
  })
})
