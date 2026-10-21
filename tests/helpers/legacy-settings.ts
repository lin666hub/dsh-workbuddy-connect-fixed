/**
 * A test double carrying the DSH 0.1.2–0.1.6 settings-section API.
 *
 * The real `@deepseek-ai/dsh-settings` service cannot stand in for it: DSH
 * 0.2.0 replaced that service with a Config-derived *forms* facade
 * (`SettingsForms`) whose `writable`/`documentPath` are accessors and which
 * has no `installSection`, no `load`/`persist` hooks, and no `get(ns)`. The
 * specs used to subclass the provider and override those hooks; against 0.2.0
 * that is both a type error (an accessor cannot be overridden by an instance
 * property) and semantically wrong — the subclass would be a forms service
 * this plugin never drives.
 *
 * So the double implements the legacy seam directly, as its own cordis
 * Service named `settings`. It is what the 0.1.5/0.1.6 host actually offered:
 * a section installer plus a namespace-keyed `update`, with the plugin's
 * reported value source feeding back through `setSource`. Keeping it here
 * (rather than mocking the real class) keeps the specs asserting the plugin's
 * wiring against a service shaped like the generation it supports.
 *
 * @module dsh-workbuddy-connect/tests/helpers/legacy-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

/** One installed section: its schema, current value, and change handlers. */
interface InstalledSection {
  schema: unknown
  value: Record<string, unknown>
  setValue(next: Record<string, unknown>): void
  onChange(): void
}

/**
 * How a subclass persists the document backing every section.
 *
 * `read` is synchronous because installation is: the plugin installs its
 * sections inside `apply()` and reads their values from the source it was
 * handed immediately afterward. An async restore started at install time
 * would still be pending when the plugin read the value, so a stored
 * preference could never survive the dispose-and-reboot cycle the restart
 * specs assert on.
 */
export interface LegacySettingsStorage {
  read(): Record<string, Record<string, unknown>>
  persist(document: Record<string, Record<string, unknown>>): Promise<void>
}

/**
 * The pre-0.1.7 settings service, as this plugin drives it.
 *
 * `describe()` reports one descriptor per installed section so the specs can
 * assert which namespaces are served — the same observable the 0.1.5 settings
 * tab and the TUI `/settings` read.
 */
export class LegacySettingsService {
  private readonly sections = new Map<string, InstalledSection>()

  constructor(private readonly storage: LegacySettingsStorage) {}

  /** Whether the active profile accepts edits; always true in these specs. */
  get writable(): boolean {
    return true
  }

  /**
   * Install one schema section, reporting its live source and edits back.
   *
   * Mirrors the real 0.1.6 `installSection` exactly: `hooks.onChange()` fires
   * once synchronously AT INSTALL TIME, not only on later edits — the real
   * service calls it unconditionally right after `setSource` (dsh-settings
   * 0.1.6, `installSection`). A stored value for the namespace is merged in
   * before that first notification, so the plugin reads a restored preference
   * through the same `onChange` it would see on a real host, and no
   * install-time `repointStores()` call of its own is needed.
   */
  installSection<T extends Record<string, unknown>>(
    _ctx: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    initial: T,
    handlers: { setSource(source: () => T): void; onChange(): void },
  ): void {
    const key = String(ns)
    const section: InstalledSection = {
      schema,
      value: { ...initial, ...this.storage.read()[key] } as Record<string, unknown>,
      setValue: next => { section.value = next },
      onChange: handlers.onChange,
    }
    this.sections.set(key, section)
    handlers.setSource(() => section.value as T)
    // The real service fires onChange() unconditionally at install.
    handlers.onChange()
  }

  /** Merge fields into one installed section, persist, and notify its owner. */
  async update(ns: SettingsNamespace, patch: object): Promise<void> {
    const key = String(ns)
    const section = this.sections.get(key)
    if (section === undefined) throw new Error(`no settings section "${key}" is installed`)
    section.value = { ...section.value, ...patch }
    section.onChange()
    await this.flush()
  }

  /**
   * Every installed section, in the descriptor shape the specs assert on:
   * namespace, schema, and current value.
   */
  describe(): { ns: SettingsNamespace; schema: unknown; value: unknown }[] {
    return [...this.sections].map(([ns, section]) => ({
      ns: ns as SettingsNamespace,
      schema: section.schema,
      value: section.value,
    }))
  }

  /** Read one section's current value, or undefined when none is installed. */
  get(ns: SettingsNamespace): Record<string, unknown> | undefined {
    return this.sections.get(String(ns))?.value
  }

  /** Persist the whole document through the subclass's storage. */
  async flush(): Promise<void> {
    const document: Record<string, Record<string, unknown>> = {}
    for (const [ns, section] of this.sections) document[ns] = section.value
    await this.storage.persist(document)
  }
}
