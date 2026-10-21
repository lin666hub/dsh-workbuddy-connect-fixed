/**
 * A test double carrying the DSH 0.2.x settings-forms API (`SettingsForms`).
 *
 * The real service derives its sections from the running composition's own
 * Loader entries, which a unit spec cannot assemble. This double keeps the
 * parts the plugin actually depends on, in the shapes the real service
 * produces (`@deepseek-ai/dsh-settings@0.2.1-rc.2`, `SettingsForms`):
 *
 *   - `describe()` returns one descriptor per entry **that has at least one
 *     `.volatile()` field** — the real `volatileForm()` projection drops
 *     entries without live-editable fields entirely. Each served descriptor
 *     carries the entry's `ns` (the profile **entry id**, not the settings
 *     namespace the 0.1.x sections were installed under), a *serialized* form
 *     schema (`volatileForm(schema).toJSON()` — a plain JSON object, never the
 *     live Config), the projected `value` (only schema-declared form fields),
 *     and a `revision` the writer may hand back to `update()`. Descriptors
 *     carry no fiber, exactly like the real ones.
 *   - `update(ns, patch, expectedRevision?)` validates exactly like the real
 *     `write()`: an id it does not serve throws the real "no configurable
 *     plugin entry" error, an entry without volatile fields throws the real
 *     "has no volatile fields" error, and a non-volatile field in the patch
 *     throws the real "is not volatile" error. Accepted writes merge into the
 *     entry's section, bump the revision, and — exactly like the real
 *     service — emit `settings/document-updated` on the emitter.
 *
 * `volatileForm` / `plainFormSchema` / `projectForm` / `isVolatilePath` below
 * are verbatim ports of the real service's private projections (dsh-settings
 * 0.2.1-rc.2, `lib/index.js`), so the gating behaviour under test is the
 * shipped one, not an approximation of it.
 *
 * Two knobs exist because the reviewer's cases are about *not* trusting a
 * write: `failNextWrite` makes the next `update()` reject after validation
 * (persistence failure), and `silent` makes it resolve without recording
 * anything (a host adapter that reports success while the document never
 * moved).
 *
 * @module dsh-workbuddy-connect/tests/helpers/modern-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Minimal schemastery-node view the ported projections walk. */
interface SchemaNode {
  type?: string
  meta?: { volatile?: boolean; role?: string; default?: unknown }
  dict?: Record<string, SchemaNode>
  inner?: SchemaNode
  list?: SchemaNode[]
  toJSON(): unknown
}

/** Narrow one caller-supplied schema to the node view (the real `schema()` guard). */
function asNode(schema: unknown): SchemaNode | undefined {
  // Schemastery schemas are callable (`typeof === 'function'`); the real
  // service's guard is exactly `schema !== undefined && 'toJSON' in schema`.
  return (typeof schema === 'object' || typeof schema === 'function')
    && schema !== null
    && 'toJSON' in schema
    ? schema as SchemaNode
    : undefined
}

/** Port of the real `plainSchema()`: rebuild a detached form schema. */
function plainFormSchema(schema: SchemaNode): SchemaNode {
  const reconstruct = z as unknown as new (definition: unknown) => SchemaNode
  const result = new reconstruct(schema.toJSON())
  const walk = (node: SchemaNode): void => {
    delete node.meta?.volatile
    if (node.meta?.role === 'secret') {
      delete node.meta.default
    }
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

/** Port of the real `volatileForm()`: keep only volatile-editable branches. */
function volatileForm(schema: SchemaNode): SchemaNode | undefined {
  if (schema.meta?.volatile) return plainFormSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : reconstructObject(dict)
  }
  return undefined
}

/** Port of the real object rebuild (`z.object(dict)`). */
function reconstructObject(dict: Record<string, SchemaNode>): SchemaNode {
  const object = (z as unknown as { object(dict: Record<string, SchemaNode>): SchemaNode }).object
  return object.call(z, dict)
}

/** Port of the real `projectForm()`: keep only schema-declared form fields. */
function projectForm(schema: SchemaNode, value: unknown): unknown {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = Reflect.get(value, key)
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}

/** Port of the real `isVolatilePath()`. */
function isVolatilePath(schema: SchemaNode, path: string[]): boolean {
  if (schema.meta?.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

/** One served entry, in the shape `describe()` reports. */
export interface ModernEntry {
  ns: string
  schema: unknown
  value: Record<string, unknown>
  revision: number
}

/** Builder options for {@link ModernSettingsForms}. */
export interface ModernSettingsFormsOptions {
  /** Entries to serve; `schema` is the entry's live schemastery Config. */
  entries: { ns: string; schema: unknown; value?: Record<string, unknown> }[]
  /** Reject the next validated write with this message (persistence failure). */
  failNextWrite?: string
  /** Resolve the next validated write without recording it (a silent no-op adapter). */
  silent?: boolean
  /** Context to emit `settings/document-updated` on; optional in pure unit tests. */
  emitter?: Context
}

/**
 * The 0.2.x forms service, reduced to what this plugin drives.
 *
 * `describe()` and `update()` are deliberately *own* methods (not accessors):
 * `modernSettingsOf` detects the generation structurally and would reject an
 * accessor-backed double that the real class also rejects detection on.
 */
export class ModernSettingsForms {
  private readonly entries: ModernEntry[]
  /** Every accepted write, so a spec can assert the target entry and value. */
  readonly writes: { ns: string; patch: Record<string, unknown>; expectedRevision: number | undefined }[] = []
  private failNextWrite: string | undefined
  private silent: boolean
  private readonly emitter: Context | undefined

  constructor(options: ModernSettingsFormsOptions) {
    this.entries = options.entries.map(entry => ({
      ns: entry.ns,
      schema: entry.schema,
      value: { ...(entry.value ?? {}) },
      revision: 0,
    }))
    this.failNextWrite = options.failNextWrite
    this.silent = options.silent === true
    this.emitter = options.emitter
  }

  /** Arm a persistence failure for the next write. */
  failNext(message = 'disk is read-only'): void {
    this.failNextWrite = message
  }

  /** Arm a silent no-op write for the next call. */
  goSilent(silent = true): void {
    this.silent = silent
  }

  /** Current stored value of one entry, or `undefined` when unserved. */
  stored(ns: string): Record<string, unknown> | undefined {
    return this.entries.find(entry => entry.ns === ns)?.value
  }

  describe(_options?: unknown): ModernEntry[] {
    return this.entries.flatMap(entry => {
      const node = asNode(entry.schema)
      const form = node === undefined ? undefined : volatileForm(node)
      // The real service emits no descriptor for an entry without volatile
      // fields — and hands out the serialized form, never the live schema.
      if (form === undefined) return []
      const value = projectForm(form, entry.value)
      return [{
        ns: entry.ns,
        schema: form.toJSON(),
        value: value === null || typeof value !== 'object' || Array.isArray(value) ? {} : value as Record<string, unknown>,
        revision: entry.revision,
      }]
    })
  }

  async update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
    const entry = this.entries.find(candidate => candidate.ns === ns)
    if (entry === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    const node = asNode(entry.schema)
    const form = node === undefined ? undefined : volatileForm(node)
    if (form === undefined) throw new Error(`Plugin entry "${ns}" has no volatile fields`)
    for (const key of Object.keys(patch)) {
      if (!isVolatilePath(node!, [key])) throw new Error(`Config field "${key}" is not volatile`)
    }
    if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
      // The real service refuses a stale revision with SettingsConflictError.
      const conflict = new Error(`settings namespace "${ns}" changed since it was read (expected revision ${String(expectedRevision)}, now ${String(entry.revision)})`)
      conflict.name = 'SettingsConflictError'
      throw conflict
    }
    if (this.failNextWrite !== undefined) {
      const message = this.failNextWrite
      this.failNextWrite = undefined
      throw new Error(message)
    }
    this.writes.push({ ns, patch: { ...(patch as Record<string, unknown>) }, expectedRevision })
    if (this.silent) {
      this.silent = false
      return
    }
    entry.value = { ...entry.value, ...(patch as Record<string, unknown>) }
    entry.revision += 1
    ;(this.emitter as unknown as { emit?: (event: string, ...args: unknown[]) => void })
      ?.emit?.('settings/document-updated', ns, entry.revision)
  }
}
