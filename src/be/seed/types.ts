/**
 * Generic entity-seeder framework.
 *
 * A {@link Seeder} declares one seedable entity *kind* (scripts now; workflows,
 * schedules, skills, ... later). The {@link runSeeder} harness drives every
 * seeder identically and enforces the versioning rule below, so adding a new
 * kind is a matter of writing one `Seeder` and registering it — not touching
 * the harness.
 *
 * Versioning rule (per item, evaluated against the `seed_state` table):
 *   - upstream entity absent              -> create
 *   - upstream identical to source        -> no-op (seed state re-baselined)
 *   - upstream pristine + source changed  -> update
 *   - upstream pristine + source same     -> no-op
 *   - upstream user-modified              -> never overwrite (preserve)
 *
 * "Pristine" means the live upstream copy still hashes identically to what the
 * framework recorded on its last successful seed of that item, under the
 * current hash formula or a legacy one ({@link Seeder.legacyUpstreamHashes}).
 */

export type SeedAction =
  | "created"
  | "updated"
  | "skipped-unchanged"
  | "skipped-user-modified"
  | "failed";

/** One source-of-truth record a seeder wants to land in the DB. */
export interface SeedItem {
  /** Stable identity within the kind — e.g. a script name. */
  readonly key: string;
  /**
   * Deterministic hash of the source-of-truth definition. Must use the same
   * hashing scheme as {@link Seeder.upstreamHash} so the two are comparable.
   */
  readonly contentHash: string;
}

export type SeederRunOptions = {
  quiet?: boolean;
  scriptEmbeddingMode?: "sync" | "skip";
};

export interface Seeder<TItem extends SeedItem = SeedItem> {
  /** Kind discriminator — namespaces this seeder's rows in `seed_state`. */
  readonly kind: string;
  /** The version-controlled source-of-truth records for this kind. */
  items(): TItem[] | Promise<TItem[]>;
  /**
   * Content hash of the *live upstream* entity for `item`, or `null` when it
   * does not exist yet. Same hashing scheme as {@link SeedItem.contentHash}.
   */
  upstreamHash(item: TItem): string | null | Promise<string | null>;
  /**
   * Optional. Hashes of the live upstream entity under any *previous* hashing
   * formula of this kind. When the recorded `seededHash` matches one of them,
   * the row is still pristine: it was seeded under the old formula and not
   * edited since. The harness then rebaselines it to the current formula. A
   * seeder only implements this when it changes what its hash covers, and
   * every legacy formula must be unable to collide with the current one.
   * Return `[]` when the entity does not exist.
   */
  legacyUpstreamHashes?(item: TItem): Promise<string[]>;
  /** Create or update the upstream entity so it matches the source definition. */
  apply(item: TItem, action: "create" | "update", opts?: SeederRunOptions): void | Promise<void>;
}

export type SeederResult = {
  kind: string;
  created: number;
  updated: number;
  skippedUnchanged: number;
  skippedUserModified: number;
  /**
   * Rows whose recorded seed hash matched a legacy formula (see
   * {@link Seeder.legacyUpstreamHashes}) and now record the current one. Not a
   * separate outcome: each is also counted as `updated` or `skippedUnchanged`.
   */
  rebaselined: number;
  failed: Array<{ key: string; error: string }>;
};
