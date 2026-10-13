import { afterEach, describe, expect, test } from "bun:test";
import {
  createSandboxUidPool,
  DEFAULT_SANDBOX_UID_BASE,
  hasSandboxUidDropCaps,
  SANDBOX_UID_DROP_CAPS,
  type SandboxUser,
  sandboxUidBase,
  sandboxUidDropAvailable,
} from "../utils/sandbox-uid";

const reaped: SandboxUser[] = [];
const reap = async (user: SandboxUser) => {
  reaped.push(user);
};

afterEach(() => {
  reaped.length = 0;
  delete process.env.SCRIPT_SANDBOX_UID_BASE;
});

describe("sandbox uid pool", () => {
  test("concurrent leases get distinct uids from the base", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 4, reap });
    const leases = await Promise.all([pool.lease(), pool.lease(), pool.lease()]);
    const uids = leases.map((lease) => lease.user.uid);
    expect(new Set(uids).size).toBe(3);
    for (const uid of uids) expect(uid >= 61000 && uid < 61004).toBe(true);
    for (const lease of leases) expect(lease.user.gid).toBe(lease.user.uid);
    expect(pool.inUse()).toBe(3);
  });

  test("release reaps the uid once, then frees the slot", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 2, reap });
    const lease = await pool.lease();
    await lease.release();
    await lease.release();
    expect(reaped).toEqual([lease.user]);
    expect(pool.inUse()).toBe(0);
  });

  test("hands out a just-released uid last", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 3, reap });
    const first = await pool.lease();
    await first.release();
    const second = await pool.lease();
    expect(second.user.uid).not.toBe(first.user.uid);
  });

  test("waits for a free slot instead of sharing a uid", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 1, reap });
    const held = await pool.lease();
    let granted: number | undefined;
    const waiting = pool.lease().then((lease) => {
      granted = lease.user.uid;
      return lease;
    });
    await Bun.sleep(20);
    expect(granted).toBeUndefined();
    await held.release();
    const next = await waiting;
    expect(next.user.uid).toBe(held.user.uid);
    expect(pool.inUse()).toBe(1);
  });

  test("an aborted wait rejects and leaves the queue clean", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 1, reap });
    const held = await pool.lease();
    const controller = new AbortController();
    const waiting = pool.lease(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    await held.release();
    expect(pool.inUse()).toBe(0);
    const again = await pool.lease();
    expect(again.user.uid).toBe(61000);
  });
});

describe("sandbox uid config", () => {
  test("a base below 1000 falls back to the default, so base - 1 is never root", () => {
    process.env.SCRIPT_SANDBOX_UID_BASE = "1";
    expect(sandboxUidBase()).toBe(DEFAULT_SANDBOX_UID_BASE);
    process.env.SCRIPT_SANDBOX_UID_BASE = "70000";
    expect(sandboxUidBase()).toBe(70000);
  });

  test.skipIf(process.getuid?.() === 0)(
    "uid drop is unavailable when the API is not root",
    async () => {
      expect(await sandboxUidDropAvailable()).toBe(false);
    },
  );
});

describe("sandbox uid capability check", () => {
  test("Docker's default root capability set is enough", () => {
    // Docker default: CHOWN DAC_OVERRIDE FOWNER FSETID KILL SETGID SETUID SETPCAP
    // NET_BIND_SERVICE NET_RAW SYS_CHROOT MKNOD AUDIT_WRITE SETFCAP.
    expect(hasSandboxUidDropCaps("Name:\tbun\nCapEff:\ta80425fb\n")).toBe(true);
  });

  test("a set without SETUID, or an empty set, is not", () => {
    expect(hasSandboxUidDropCaps("CapEff:\ta804257b\n")).toBe(false);
    expect(hasSandboxUidDropCaps("CapEff:\t0000000000000000\n")).toBe(false);
    expect(hasSandboxUidDropCaps("Name:\tbun\n")).toBe(false);
  });

  test("the minimal Helm add-back set is enough", () => {
    const bits = Object.values(SANDBOX_UID_DROP_CAPS).reduce((mask, bit) => mask | (1 << bit), 0);
    expect(hasSandboxUidDropCaps(`CapEff:\t${bits.toString(16).padStart(16, "0")}\n`)).toBe(true);
  });
});
