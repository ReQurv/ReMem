/**
 * `remem-skill` bin — installs the bundled Agent Skill into agent harnesses.
 *
 * Commands:
 *   install [--harness <id>] [--scope project|global] [--project <dir>] [--force]
 *   list    show target paths and install state
 *   show    print the bundled SKILL.md
 *   path    print the bundled SKILL.md path
 *
 * No external deps (manual arg parsing). Exit code 1 on errors and on
 * conflicts left unresolved (a customized copy in place without --force).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  detectHarnesses,
  HARNESSES,
  installSkill,
  listInstalls,
  resolveHarness,
  SKILL_FILE,
  type HarnessScope,
} from './harnesses'

const USAGE = `remem-skill — install the ReMem agent skill into an agent harness

Usage:
  remem-skill install [options]   install the skill
  remem-skill list                show target paths and install state
  remem-skill show                print the bundled SKILL.md
  remem-skill path                print the bundled SKILL.md path

Install options:
  --harness <id>    claude-code | opencode (default: all detected)
  --scope <scope>   project (default) | global
  --project <dir>   project root (default: cwd)
  --force           overwrite a customized existing copy
  -h, --help        show this help

Without --harness, install detects which harness is present (project marker
in the project root, or home marker for --scope global) and installs into
every one it finds.`

interface CliOpts {
  command?: string
  harness?: string
  scope: HarnessScope
  project?: string
  force: boolean
  help: boolean
}

function parseError(msg: string): never {
  throw new Error(msg)
}

function parse(argv: string[]): CliOpts {
  const out: CliOpts = { scope: 'project', force: false, help: false }
  const needValue = (flag: string, value: string | undefined): string =>
    value ?? parseError(`missing value for ${flag}`)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-h':
      case '--help':
        out.help = true
        break
      case '--harness':
        out.harness = needValue(a, argv[++i])
        break
      case '--scope':
        out.scope = needValue(a, argv[++i]) as HarnessScope
        break
      case '--project':
        out.project = needValue(a, argv[++i])
        break
      case '--force':
        out.force = true
        break
      default:
        if (a.startsWith('-')) parseError(`unknown option: ${a}`)
        if (out.command) parseError(`unexpected argument: ${a}`)
        out.command = a
    }
  }
  if (out.scope !== 'project' && out.scope !== 'global') {
    parseError(`invalid --scope "${out.scope}" (expected project | global)`)
  }
  return out
}

/**
 * Locate the bundled SKILL.md. `dist/remem-skill.js` sits one level under the
 * package root (npm layout); `src/skill/cli.ts` (dev) sits two levels under
 * the repo root. `REMEM_SKILL_PATH` overrides both.
 */
function bundledSkillPath(): string {
  const candidates: string[] = []
  if (process.env.REMEM_SKILL_PATH) candidates.push(resolve(process.env.REMEM_SKILL_PATH))
  candidates.push(
    fileURLToPath(new URL(`../skills/remem/${SKILL_FILE}`, import.meta.url)),
    fileURLToPath(new URL(`../../skills/remem/${SKILL_FILE}`, import.meta.url)),
  )
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(`bundled ${SKILL_FILE} not found (looked for: ${candidates.join(', ')})`)
}

function runInstall(opts: CliOpts): number {
  const projectDir = resolve(opts.project ?? process.cwd())
  const skillPath = bundledSkillPath()
  const harnesses = opts.harness
    ? [resolveHarness(opts.harness)]
    : detectHarnesses(opts.scope, { projectDir })
  if (harnesses.length === 0) {
    console.error(`no ${opts.scope}-scope harness detected for install`)
    console.error(
      `markers looked for: ${HARNESSES.map((h) => h.marker(opts.scope, { projectDir, homeDir: homedir() })).join(', ')}`,
    )
    console.error('pass --harness to install into a specific one')
    return 1
  }
  let failed = false
  for (const h of harnesses) {
    const r = installSkill({ skillPath, harness: h, scope: opts.scope, projectDir, force: opts.force })
    if (r.status === 'conflict') {
      console.log(`${h.id} (${opts.scope}) skipped — existing copy differs at ${r.path} (use --force to overwrite)`)
      failed = true
    } else {
      console.log(`${h.id} (${opts.scope}) ${r.status} → ${r.path}`)
    }
  }
  return failed ? 1 : 0
}

function runList(opts: CliOpts): number {
  const rows = listInstalls({ projectDir: resolve(opts.project ?? process.cwd()) })
  console.log(`${'harness'.padEnd(12)} ${'scope'.padEnd(8)} target`)
  for (const r of rows) {
    console.log(`${r.harness.id.padEnd(12)} ${r.scope.padEnd(8)} ${r.path}${r.installed ? '  (installed)' : ''}`)
  }
  return 0
}

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2))
  if (opts.help || !opts.command) {
    console.log(USAGE)
    process.exit(opts.help ? 0 : 1)
  }
  let code: number
  switch (opts.command) {
    case 'install':
      code = runInstall(opts)
      break
    case 'list':
      code = runList(opts)
      break
    case 'show':
      console.log(readFileSync(bundledSkillPath(), 'utf8'))
      code = 0
      break
    case 'path':
      console.log(bundledSkillPath())
      code = 0
      break
    default:
      console.error(`unknown command: ${opts.command}`)
      console.error(USAGE)
      code = 1
  }
  process.exit(code)
}

main().catch((err) => {
  console.error('[fatal]', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
