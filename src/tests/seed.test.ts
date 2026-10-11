import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  getSeedState,
  recordSeedState,
  runSeeder,
  type Seeder,
  type SeederRunOptions,
  type SeedItem,
} from "../be/seed";

const TEST_DB_PATH = "./test-seed.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

/**
 * A fake seeder backed by two in-memory maps so the harness can be exercised
 * without any concrete entity kind. `source` is the version-controlled
 * definition; `upstream` is the live DB. `apply` faithfully writes source into
 * upstream, mirroring a real seeder.
 */
function makeFakeSeeder(
  kind: string,
  source: Map<string, string>,
  upstream: Map<string, string>,
): Seeder<SeedItem> {
  return {
    kind,
    items: () => [...source.entries()].map(([key, contentHash]) => ({ key, contentHash })),
    upstreamHash: (item) => upstream.get(item.key) ?? null,
    apply: (item) => {
      upstream.set(item.key, item.contentHash);
    },
  };
}

describe("seeder harness — versioning rule", () => {
  test("absent upstream -> create, and records seed state", async () => {
    const source = new Map([
      ["a", "h-a1"],
      ["b", "h-b1"],
    ]);
    const upstream = new Map<string, string>();
    const seeder = makeFakeSeeder("create-test", source, upstream);

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.failed).toEqual([]);
    expect(upstream.get("a")).toBe("h-a1");
    expect((await getSeedState("create-test", "a"))?.seededHash).toBe("h-a1");
  });

  test("pristine upstream + unchanged source -> no-op", async () => {
    const source = new Map([["a", "h-a1"]]);
    const upstream = new Map([["a", "h-a1"]]);
    const seeder = makeFakeSeeder("noop-test", source, upstream);

    await runSeeder(seeder, { quiet: true }); // seed once
    const result = await runSeeder(seeder, { quiet: true }); // re-seed
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUnchanged).toBe(1);
    expect(result.skippedUserModified).toBe(0);
  });

  test("pristine upstream + changed source -> update", async () => {
    const source = new Map([["a", "h-a1"]]);
    const upstream = new Map<string, string>();
    const seeder = makeFakeSeeder("update-test", source, upstream);

    await runSeeder(seeder, { quiet: true }); // creates a@h-a1
    source.set("a", "h-a2"); // source moves; upstream still pristine at h-a1

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.updated).toBe(1);
    expect(result.skippedUnchanged).toBe(0);
    expect(upstream.get("a")).toBe("h-a2");
    expect((await getSeedState("update-test", "a"))?.seededHash).toBe("h-a2");
  });

  test("user-modified upstream -> preserved, never overwritten", async () => {
    const source = new Map([["a", "h-a1"]]);
    const upstream = new Map<string, string>();
    const seeder = makeFakeSeeder("preserve-test", source, upstream);

    await runSeeder(seeder, { quiet: true }); // creates a@h-a1
    upstream.set("a", "h-user-edit"); // a user changes it upstream
    source.set("a", "h-a2"); // and the source also moves on

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUserModified).toBe(1);
    // The user's edit survived — the harness did not clobber it.
    expect(upstream.get("a")).toBe("h-user-edit");
    // Seed state keeps the original baseline, so the edit stays detectable.
    expect((await getSeedState("preserve-test", "a"))?.seededHash).toBe("h-a1");
  });

  test("pre-existing entity identical to source with no seed state -> adopted as no-op", async () => {
    const source = new Map([["x", "h-x1"]]);
    const upstream = new Map([["x", "h-x1"]]); // pre-exists, byte-identical, never seeded
    const seeder = makeFakeSeeder("adopt-test", source, upstream);

    expect(await getSeedState("adopt-test", "x")).toBeNull();
    const first = await runSeeder(seeder, { quiet: true });
    expect(first.skippedUnchanged).toBe(1);
    // It was adopted: seed state is now recorded so a future change is detectable.
    expect((await getSeedState("adopt-test", "x"))?.seededHash).toBe("h-x1");

    source.set("x", "h-x2");
    const second = await runSeeder(seeder, { quiet: true });
    expect(second.updated).toBe(1);
    expect(upstream.get("x")).toBe("h-x2");
  });

  test("edited then reset to current source -> re-baselined, and later source changes apply", async () => {
    const source = new Map([["r", "h-A"]]);
    const upstream = new Map<string, string>();
    const seeder = makeFakeSeeder("reset-test", source, upstream);

    await runSeeder(seeder, { quiet: true }); // seededHash=A, live=A
    source.set("r", "h-B"); // source moves to B
    upstream.set("r", "h-B"); // live was edited, then reset to byte-identical B

    const first = await runSeeder(seeder, { quiet: true });
    expect(first.updated).toBe(0);
    expect(first.skippedUnchanged).toBe(1);
    expect(first.skippedUserModified).toBe(0);
    expect((await getSeedState("reset-test", "r"))?.seededHash).toBe("h-B");

    source.set("r", "h-C"); // a later upstream change must now land
    const second = await runSeeder(seeder, { quiet: true });
    expect(second.updated).toBe(1);
    expect(second.skippedUserModified).toBe(0);
    expect(upstream.get("r")).toBe("h-C");
    expect((await getSeedState("reset-test", "r"))?.seededHash).toBe("h-C");
  });

  test("pre-existing entity differing from source with no seed state -> preserved (conservative)", async () => {
    const source = new Map([["y", "h-src"]]);
    const upstream = new Map([["y", "h-pre-existing"]]); // pre-exists, never seeded
    const seeder = makeFakeSeeder("conservative-test", source, upstream);

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUserModified).toBe(1);
    expect(upstream.get("y")).toBe("h-pre-existing");
  });

  test("runner passes opts through to apply()", async () => {
    const capturedOpts: (SeederRunOptions | undefined)[] = [];
    const source = new Map([["a", "h-a1"]]);
    const upstream = new Map<string, string>();
    const seeder: Seeder<SeedItem> = {
      kind: "opts-passthrough-test",
      items: () => [...source.entries()].map(([key, contentHash]) => ({ key, contentHash })),
      upstreamHash: (item) => upstream.get(item.key) ?? null,
      apply: (item, _action, opts) => {
        capturedOpts.push(opts);
        upstream.set(item.key, item.contentHash);
      },
    };

    await runSeeder(seeder, { quiet: true, scriptEmbeddingMode: "skip" });
    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0]?.scriptEmbeddingMode).toBe("skip");
  });

  describe("legacyUpstreamHashes", () => {
    /**
     * Like makeFakeSeeder, plus a `legacy` map: the live row's hash under an
     * older hash formula. Records how often the hook was asked.
     */
    function makeLegacySeeder(
      kind: string,
      source: Map<string, string>,
      upstream: Map<string, string>,
      legacy: Map<string, string[]>,
    ) {
      const calls: string[] = [];
      const seeder: Seeder<SeedItem> = {
        ...makeFakeSeeder(kind, source, upstream),
        legacyUpstreamHashes: async (item) => {
          calls.push(item.key);
          return legacy.get(item.key) ?? [];
        },
      };
      return { seeder, calls };
    }

    test("legacy match + source moved -> updated, rebaselined to the current formula", async () => {
      const source = new Map([["a", "h-new-src2"]]);
      const upstream = new Map([["a", "h-new-live"]]);
      const legacy = new Map([["a", ["h-old-live-x", "h-old-live-y"]]]);
      await recordSeedState("legacy-update-test", "a", "h-old-live-y");
      const { seeder } = makeLegacySeeder("legacy-update-test", source, upstream, legacy);

      const result = await runSeeder(seeder, { quiet: true });
      expect(result).toMatchObject({
        updated: 1,
        skippedUserModified: 0,
        rebaselined: 1,
        failed: [],
      });
      expect(upstream.get("a")).toBe("h-new-src2");
      expect((await getSeedState("legacy-update-test", "a"))?.seededHash).toBe("h-new-src2");
    });

    test("legacy match + live equals source -> unchanged, rebaselined to the current formula", async () => {
      const source = new Map([["a", "h-new"]]);
      const upstream = new Map([["a", "h-new"]]);
      const legacy = new Map([["a", ["h-old"]]]);
      await recordSeedState("legacy-unchanged-test", "a", "h-old");
      const { seeder } = makeLegacySeeder("legacy-unchanged-test", source, upstream, legacy);

      const result = await runSeeder(seeder, { quiet: true });
      expect(result).toMatchObject({ skippedUnchanged: 1, rebaselined: 1, updated: 0 });
      expect((await getSeedState("legacy-unchanged-test", "a"))?.seededHash).toBe("h-new");

      // Idempotent: the row now carries a current-formula hash.
      const again = await runSeeder(seeder, { quiet: true });
      expect(again).toMatchObject({ skippedUnchanged: 1, rebaselined: 0 });
    });

    test("no legacy match -> still preserved, nothing rebaselined", async () => {
      const source = new Map([["a", "h-src2"]]);
      const upstream = new Map([["a", "h-user-edit"]]);
      const legacy = new Map([["a", ["h-old-of-user-edit"]]]);
      await recordSeedState("legacy-miss-test", "a", "h-seeded");
      const { seeder } = makeLegacySeeder("legacy-miss-test", source, upstream, legacy);

      const result = await runSeeder(seeder, { quiet: true });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      expect(upstream.get("a")).toBe("h-user-edit");
      expect((await getSeedState("legacy-miss-test", "a"))?.seededHash).toBe("h-seeded");
    });

    test("the hook is not consulted when the recorded hash already matches", async () => {
      const source = new Map([["a", "h-1"]]);
      const upstream = new Map<string, string>();
      const { seeder, calls } = makeLegacySeeder("legacy-skip-test", source, upstream, new Map());

      await runSeeder(seeder, { quiet: true }); // create
      source.set("a", "h-2");
      const result = await runSeeder(seeder, { quiet: true }); // pristine update
      expect(result).toMatchObject({ updated: 1, rebaselined: 0 });
      expect(calls).toEqual([]);
    });

    test("a seeder without the hook keeps the old rule: a recorded mismatch is preserved", async () => {
      const source = new Map([["a", "h-new-src"]]);
      const upstream = new Map([["a", "h-new-live"]]);
      await recordSeedState("legacy-absent-test", "a", "h-old-live");
      const seeder = makeFakeSeeder("legacy-absent-test", source, upstream);

      const result = await runSeeder(seeder, { quiet: true });
      expect(result).toMatchObject({ skippedUserModified: 1, rebaselined: 0 });
      expect(upstream.get("a")).toBe("h-new-live");
    });
  });

  test("a throwing apply is captured per-item without aborting the run", async () => {
    const source = new Map([
      ["ok", "h-ok"],
      ["bad", "h-bad"],
    ]);
    const upstream = new Map<string, string>();
    const seeder: Seeder<SeedItem> = {
      kind: "failure-test",
      items: () => [...source.entries()].map(([key, contentHash]) => ({ key, contentHash })),
      upstreamHash: (item) => upstream.get(item.key) ?? null,
      apply: (item) => {
        if (item.key === "bad") throw new Error("boom");
        upstream.set(item.key, item.contentHash);
      },
    };

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(1);
    expect(result.failed).toEqual([{ key: "bad", error: "boom" }]);
    expect(upstream.get("ok")).toBe("h-ok");
    // A failed apply did not record seed state, so a later run retries it.
    expect(await getSeedState("failure-test", "bad")).toBeNull();
  });
});
