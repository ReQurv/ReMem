/**
 * Agent-skill installer core: the harness registry plus install/detect/list
 * logic.
 *
 * A "harness" is an agent runtime (Claude Code, OpenCode, …) that loads
 * Agent Skills from well-known directories: `<skillsRoot>/<skill-dir>/SKILL.md`.
 * `installSkill` copies the bundled skill file into the target location.
 * `projectDir`/`homeDir` are injectable so the functions stay testable
 * (defaults: `process.cwd()` and `os.homedir()`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type HarnessScope = 'project' | 'global'

export interface HarnessLocals {
  projectDir: string
  homeDir: string
}

export interface Harness {
  id: string
  label: string
  /** Skills root the skill directory is placed under. */
  skillsRoot(scope: HarnessScope, loc: HarnessLocals): string
  /** Directory whose existence marks the harness as in use (detection). */
  marker(scope: HarnessScope, loc: HarnessLocals): string
}

/** Skill directory name and file, identical across all harnesses. */
export const SKILL_DIR = 'remem'
export const SKILL_FILE = 'SKILL.md'

export const HARNESSES: readonly Harness[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    skillsRoot: (scope, { projectDir, homeDir }) =>
      scope === 'project' ? join(projectDir, '.claude', 'skills') : join(homeDir, '.claude', 'skills'),
    marker: (scope, { projectDir, homeDir }) =>
      scope === 'project' ? join(projectDir, '.claude') : join(homeDir, '.claude'),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    skillsRoot: (scope, { projectDir, homeDir }) =>
      scope === 'project'
        ? join(projectDir, '.opencode', 'skills')
        : join(homeDir, '.config', 'opencode', 'skills'),
    marker: (scope, { projectDir, homeDir }) =>
      scope === 'project' ? join(projectDir, '.opencode') : join(homeDir, '.config', 'opencode'),
  },
]

export function resolveHarness(id: string): Harness {
  const h = HARNESSES.find((x) => x.id === id)
  if (!h) throw new Error(`unknown harness "${id}" (available: ${HARNESSES.map((x) => x.id).join(', ')})`)
  return h
}

export interface LocalsOpts {
  projectDir?: string
  homeDir?: string
}

export function resolveLocals(opts: LocalsOpts = {}): HarnessLocals {
  return { projectDir: opts.projectDir ?? process.cwd(), homeDir: opts.homeDir ?? homedir() }
}

export type InstallStatus = 'installed' | 'updated' | 'unchanged' | 'conflict'

export interface InstallResult {
  harness: Harness
  scope: HarnessScope
  /** Path of the installed (or pre-existing) SKILL.md. */
  path: string
  status: InstallStatus
}

export interface InstallOpts extends LocalsOpts {
  /** Path of the source SKILL.md to copy. */
  skillPath: string
  harness: Harness
  scope: HarnessScope
  /** Overwrite an existing, customized copy (default: skip it). */
  force?: boolean
}

/**
 * Copy the skill into `<skillsRoot>/remem/SKILL.md`. Idempotent: an identical
 * existing file is left alone (`unchanged`); a differing one is skipped
 * (`conflict`) unless `force` is set (`updated`).
 */
export function installSkill(opts: InstallOpts): InstallResult {
  const loc = resolveLocals(opts)
  const path = join(opts.harness.skillsRoot(opts.scope, loc), SKILL_DIR, SKILL_FILE)
  const content = readFileSync(opts.skillPath, 'utf8')
  const result: InstallResult = { harness: opts.harness, scope: opts.scope, path, status: 'installed' }
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) {
      result.status = 'unchanged'
      return result
    }
    if (!opts.force) {
      result.status = 'conflict'
      return result
    }
    result.status = 'updated'
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return result
}

/** Harnesses whose marker directory exists (auto-detection on install). */
export function detectHarnesses(scope: HarnessScope, opts: LocalsOpts = {}): Harness[] {
  const loc = resolveLocals(opts)
  return HARNESSES.filter((h) => existsSync(h.marker(scope, loc)))
}

export interface HarnessInstallInfo {
  harness: Harness
  scope: HarnessScope
  path: string
  installed: boolean
}

/** One row per harness × scope: target path and whether the skill is there. */
export function listInstalls(opts: LocalsOpts = {}): HarnessInstallInfo[] {
  const loc = resolveLocals(opts)
  const rows: HarnessInstallInfo[] = []
  for (const scope of ['project', 'global'] as const) {
    for (const harness of HARNESSES) {
      const path = join(harness.skillsRoot(scope, loc), SKILL_DIR, SKILL_FILE)
      rows.push({ harness, scope, path, installed: existsSync(path) })
    }
  }
  return rows
}
