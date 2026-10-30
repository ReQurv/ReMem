import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import {
  detectHarnesses,
  HARNESSES,
  installSkill,
  listInstalls,
  resolveHarness,
} from '../../src/skill/harnesses'

const SKILL_CONTENT = '# ReMem skill (test fixture)\n'
const roots: string[] = []

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'remem-skill-'))
  roots.push(root)
  const project = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
  const skillPath = join(root, 'SKILL.md')
  writeFileSync(skillPath, SKILL_CONTENT)
  return { root, project, home, skillPath }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('harness registry', () => {
  test('defines claude-code and opencode with the expected target layouts', () => {
    const loc = { projectDir: '/p', homeDir: '/home' }
    const cc = resolveHarness('claude-code')
    const oc = resolveHarness('opencode')
    expect(cc.skillsRoot('project', loc)).toBe('/p/.claude/skills')
    expect(cc.skillsRoot('global', loc)).toBe('/home/.claude/skills')
    expect(oc.skillsRoot('project', loc)).toBe('/p/.opencode/skills')
    expect(oc.skillsRoot('global', loc)).toBe('/home/.config/opencode/skills')
    expect(HARNESSES.map((h) => h.id).sort()).toEqual(['claude-code', 'opencode'])
  })

  test('resolveHarness rejects unknown ids with the available list', () => {
    expect(() => resolveHarness('cursor')).toThrow(/unknown harness "cursor" \(available: claude-code, opencode\)/)
  })
})

describe('installSkill', () => {
  test('copies the skill into the harness skills dir', () => {
    const d = makeDirs()
    const r = installSkill({
      skillPath: d.skillPath,
      harness: resolveHarness('claude-code'),
      scope: 'project',
      projectDir: d.project,
      homeDir: d.home,
    })
    expect(r.status).toBe('installed')
    expect(r.path).toBe(join(d.project, '.claude', 'skills', 'remem', 'SKILL.md'))
    expect(readFileSync(r.path, 'utf8')).toBe(SKILL_CONTENT)
  })

  test('is idempotent: an identical existing copy is left alone', () => {
    const d = makeDirs()
    const opts = {
      skillPath: d.skillPath,
      harness: resolveHarness('opencode'),
      scope: 'global' as const,
      projectDir: d.project,
      homeDir: d.home,
    }
    expect(installSkill(opts).status).toBe('installed')
    const second = installSkill(opts)
    expect(second.status).toBe('unchanged')
    expect(existsSync(second.path)).toBe(true)
  })

  test('skips a customized copy unless force is set', () => {
    const d = makeDirs()
    const opts = {
      skillPath: d.skillPath,
      harness: resolveHarness('claude-code'),
      scope: 'project' as const,
      projectDir: d.project,
      homeDir: d.home,
    }
    const first = installSkill(opts)
    writeFileSync(first.path, '# user-customized skill\n')
    expect(installSkill(opts).status).toBe('conflict')
    expect(readFileSync(first.path, 'utf8')).toBe('# user-customized skill\n')
    const forced = installSkill({ ...opts, force: true })
    expect(forced.status).toBe('updated')
    expect(readFileSync(first.path, 'utf8')).toBe(SKILL_CONTENT)
  })
})

describe('detectHarnesses', () => {
  test('detects nothing when no marker dirs exist', () => {
    const d = makeDirs()
    expect(detectHarnesses('project', { projectDir: d.project, homeDir: d.home })).toEqual([])
    expect(detectHarnesses('global', { projectDir: d.project, homeDir: d.home })).toEqual([])
  })

  test('project scope uses markers in the project root', () => {
    const d = makeDirs()
    const opts = { projectDir: d.project, homeDir: d.home }
    expect(detectHarnesses('project', opts).map((h) => h.id)).toEqual([])
    mkdirSync(join(d.project, '.claude'))
    expect(detectHarnesses('project', opts).map((h) => h.id)).toEqual(['claude-code'])
    mkdirSync(join(d.project, '.opencode'))
    expect(detectHarnesses('project', opts).map((h) => h.id)).toEqual(['claude-code', 'opencode'])
  })

  test('global scope uses markers under the home dir', () => {
    const d = makeDirs()
    mkdirSync(join(d.project, '.claude')) // must NOT count for global scope
    mkdirSync(join(d.home, '.config', 'opencode'), { recursive: true })
    const opts = { projectDir: d.project, homeDir: d.home }
    expect(detectHarnesses('global', opts).map((h) => h.id)).toEqual(['opencode'])
  })
})

describe('listInstalls', () => {
  test('reports one row per harness × scope with the right installed flag', () => {
    const d = makeDirs()
    const opts = { projectDir: d.project, homeDir: d.home }
    installSkill({
      skillPath: d.skillPath,
      harness: resolveHarness('opencode'),
      scope: 'project',
      ...opts,
    })
    const rows = listInstalls(opts)
    expect(rows).toHaveLength(4)
    const byKey = new Map(rows.map((r) => [`${r.harness.id}/${r.scope}`, r]))
    expect(byKey.get('opencode/project')?.installed).toBe(true)
    expect(byKey.get('claude-code/project')?.installed).toBe(false)
    expect(byKey.get('claude-code/global')?.installed).toBe(false)
    expect(byKey.get('opencode/global')?.installed).toBe(false)
    expect(byKey.get('claude-code/project')?.path).toBe(join(d.project, '.claude', 'skills', 'remem', 'SKILL.md'))
    expect(byKey.get('opencode/global')?.path).toBe(join(d.home, '.config', 'opencode', 'skills', 'remem', 'SKILL.md'))
  })
})
