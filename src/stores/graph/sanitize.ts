/**
 * Sanitizers for graph identifiers that are interpolated into Cypher
 * (labels/relationship types cannot be parameterized). They also normalize
 * LLM-extracted ids so they are safe and stable.
 */

/** Graph node label: alphanumerics + underscore, must not start with a digit. */
export function sanitizeLabel(s: string): string {
  let out = s.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (/^[0-9]/.test(out)) out = `_${out}`
  return out || 'Entity'
}

/** Relationship type: UPPER_SNAKE, alphanumerics + underscore. */
export function sanitizeType(s: string): string {
  let out = s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (/^[0-9]/.test(out)) out = `_${out}`
  return out || 'RELATED_TO'
}

/** Entity id: short kebab-case. Falls back to a sanitized `fallback` (e.g. name). */
export function sanitizeId(s: string, fallback?: string): string {
  const toKebab = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return toKebab(s) || toKebab(fallback ?? '') || 'node'
}

/** Property key: identifier-safe (alphanumerics + underscore, no leading digit). */
export function sanitizePropertyKey(s: string): string {
  let out = s.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (/^[0-9]/.test(out)) out = `_${out}`
  return out || 'prop'
}

/**
 * Neo4j properties can only be primitives or arrays of primitives
 * (the driver rejects nested objects / `Map`).
 */
export function isStorableValue(v: unknown): boolean {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true
  if (Array.isArray(v)) {
    return v.length > 0 && v.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')
  }
  return false
}
