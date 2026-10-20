import type { Subsystem } from '../types'
import type { RouteDecision, RouteState, Router } from './types'

/**
 * Default System-1 router: fast, deterministic, zero-LLM, zero I/O.
 *
 * Conservative by design: in case of doubt it includes MORE targets (over-
 * retrieval is cheap — the stores are fast — under-retrieval is not).
 * `index` is NEVER a write target: the index is populated only by explicit
 * `mem.index()` (M4). `state.source` on store is provenance metadata, not a
 * routing trigger.
 *
 * Thresholds/keywords are tunable constants (Italian + English).
 */

// --- tunables -------------------------------------------------------------

/** Content at/above this length is assumed to carry extractable entities. */
const MIN_GRAPH_CONTENT_LENGTH = 40

/**
 * Words that mark RELATIONAL content (write): entities + links, worth
 * extracting into the knowledge graph.
 */
const WRITE_RELATIONAL_RE = /\b(è|sono|ha|hanno|usa|usano|utilizza|collabora|collaborano|preferisce|crea|sviluppa|gestisce|progetta|legato|collegato|relazione|dipende|dipende da|fanno parte|works? with|uses?|utiliz\w+|collaborates?|prefers?|relat\w+|connected|depends?|belongs?|manages?|develops?|creates?)\b/i

/**
 * Words that mark a RELATIONAL query (read): "who/why/between/how is X
 * connected" → the graph holds the answer.
 */
const READ_RELATIONAL_RE = /\b(chi|che|perché|perchè|come|quale|quali|collegato|collegata|collegamenti|collegamento|legato|legata|relazione|relazioni|dipendenza|dipendenze|chiama|chiamato|dipende|tra|why|who|which|whom|how|related|relationship|relations|connect\w*|depend\w*|between|links?)/i

/**
 * Words that mark a FILE/PATH query (read): the index (file map) holds the
 * answer.
 */
const READ_FILE_RE = /\b(file|files|cartella|cartelle|directory|folder|folders|percorso|percorsi|path|paths|estensione|estensioni|documento|documenti|dove|in quale file|in quale cartella|which file|which folder|where)/i

/** File-extension mentions, e.g. "il file .ts", "un .md". */
const READ_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|md|mdx|txt|py|json|ya?ml|toml|sh|css|scss|html|csv|sql)\b/i

/** Path-like tokens, e.g. "src/auth/login.ts", "docs/guide". */
const READ_PATHLIKE_RE = /(?:^|[\s"'`([])(?:[\w.-]+\/)+[\w.-]+/

// --- implementation -------------------------------------------------------

function words(list: string[]): string {
  return list.join(' ')
}

export class HeuristicRouter implements Router {
  async routeWrite(state: RouteState): Promise<RouteDecision> {
    const text = (state.content ?? '').trim()
    const targets: Subsystem[] = ['vector']
    let confidence = 1.0
    let reasoning = 'default: embed content into vector store'

    if (text.length === 0) {
      reasoning = 'empty content: vector only'
    } else if (WRITE_RELATIONAL_RE.test(text)) {
      targets.push('graph')
      reasoning = `relational markers (${words(matchAll(text, WRITE_RELATIONAL_RE))}) → extract entities into graph`
    } else if (text.length >= MIN_GRAPH_CONTENT_LENGTH) {
      targets.push('graph')
      confidence = 0.8
      reasoning = `content length ${text.length} ≥ ${MIN_GRAPH_CONTENT_LENGTH} → likely entity-rich, try graph`
    }

    return { targets, confidence, reasoning }
  }

  async routeRead(state: RouteState): Promise<RouteDecision> {
    const query = (state.query ?? '').trim()
    const targets: Subsystem[] = ['vector']
    const reasons: string[] = []

    if (READ_RELATIONAL_RE.test(query)) {
      targets.push('graph')
      reasons.push(`relational query (${words(matchAll(query, READ_RELATIONAL_RE))})`)
    }
    if (READ_FILE_RE.test(query) || READ_EXT_RE.test(query) || READ_PATHLIKE_RE.test(query)) {
      targets.push('index')
      reasons.push('file/path query')
    }

    return {
      targets,
      // multiple targets = a heuristic keyword guess, not a certainty
      confidence: reasons.length > 0 ? 0.9 : 1.0,
      reasoning: reasons.length > 0 ? `vector + ${reasons.join('; ')}` : 'factual recall: vector only',
    }
  }
}

/** Distinct matched keywords (lowercased), for `reasoning` text. */
function matchAll(text: string, re: RegExp): string[] {
  // re.test() above used the non-global regex (stateless); clone for matchAll.
  const g = new RegExp(re.source, 'gi')
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(g)) {
    const w = m[1].toLowerCase()
    if (!seen.has(w)) {
      seen.add(w)
      out.push(w)
    }
  }
  return out.slice(0, 3)
}
