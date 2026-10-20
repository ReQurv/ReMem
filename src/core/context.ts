import type { GraphInsight } from '../stores/graph/types'
import type { IndexHit, IndexMap } from '../stores/index/types'
import type { VectorHit } from '../stores/vector/types'
import type { Recall, Subsystem } from '../types'

/**
 * Compose the recall context: a `Recall` whose `toPrompt()` renders ONLY the
 * sections that have data (Memory / Knowledge / Index), compactly truncated —
 * it feeds an LLM context, so brevity is a requirement, not a nice-to-have.
 */

const MAX_SNIPPET = 300
const MAX_PROMPT_CHARS = 4000

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function memorySnippet(payload: Record<string, unknown>): string {
  const c = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload)
  return truncate(c.trim(), MAX_SNIPPET)
}

export interface BuildContextArgs {
  query: string
  memories?: VectorHit[]
  graph?: GraphInsight
  index?: IndexMap | IndexHit[]
  sources: Subsystem[]
  degraded?: Subsystem[]
}

export function buildContext(args: BuildContextArgs): Recall {
  const { memories, graph, index, sources, degraded } = args

  const toPrompt = (): string => {
    const sections: string[] = []

    if (memories && memories.length > 0) {
      sections.push('## Memory')
      for (const m of memories) {
        sections.push(`- (${m.score.toFixed(2)}) ${memorySnippet(m.payload)}`)
      }
    }

    if (graph && (graph.entities.length > 0 || graph.relations.length > 0)) {
      sections.push('## Knowledge')
      for (const e of graph.entities) sections.push(`- [${e.label}] ${e.name}`)
      for (const r of graph.relations) sections.push(`- ${r.from} —${r.type}→ ${r.to}`)
      if (graph.summary) sections.push(graph.summary)
    }

    if (index) {
      sections.push('## Index')
      if (Array.isArray(index)) {
        for (const h of index) {
          sections.push(`- ${h.path}${h.description ? ` — ${h.description}` : ''}`)
        }
      } else {
        sections.push(index.toPrompt())
      }
    }

    if (sections.length === 0) sections.push('(no results)')
    if (degraded && degraded.length > 0) {
      sections.push(`_degraded: ${degraded.join(', ')}_`)
    }

    return truncate(sections.join('\n'), MAX_PROMPT_CHARS)
  }

  return {
    memories: memories ?? [],
    graph,
    index,
    sources,
    degraded,
    toPrompt,
  }
}
