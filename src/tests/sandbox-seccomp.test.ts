import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { interpretSandboxProbe, sandboxProbeInput } from "../scripts-runtime/sandbox-probe";
import {
  buildExecDenyProgram,
  encodeProgram,
  SECCOMP_ARCH_TABLES,
} from "../scripts-runtime/sandbox-seccomp";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const ALLOW = 0x7fff0000;
const EPERM = 0x00050001;
const KILL_PROCESS = 0x80000000;

/** Run the encoded BPF program over one seccomp_data, like the kernel would. */
function evaluate(bytes: Uint8Array, arch: number, nr: number): number {
  const view = new DataView(bytes.buffer);
  let accumulator = 0;
  let pc = 0;
  for (let steps = 0; steps < 64; steps++) {
    const code = view.getUint16(pc * 8, true);
    const jt = view.getUint8(pc * 8 + 2);
    const jf = view.getUint8(pc * 8 + 3);
    const k = view.getUint32(pc * 8 + 4, true);
    if (code === 0x20) {
      accumulator = k === 4 ? arch : k === 0 ? nr : Number.NaN;
      pc += 1;
    } else if (code === 0x15) {
      pc += 1 + (accumulator === k ? jt : jf);
    } else if (code === 0x35) {
      pc += 1 + (accumulator >>> 0 >= k ? jt : jf);
    } else if (code === 0x06) {
      return k >>> 0;
    } else {
      throw new Error(`unexpected opcode ${code}`);
    }
  }
  throw new Error("program did not return");
}

describe("seccomp exec-deny program", () => {
  for (const [arch, table] of Object.entries(SECCOMP_ARCH_TABLES)) {
    const program = encodeProgram(buildExecDenyProgram(table));

    test(`${arch}: denies every listed syscall with EPERM`, () => {
      for (const nr of Object.values(table.denied)) {
        expect(evaluate(program, table.auditArch, nr)).toBe(EPERM);
      }
    });

    test(`${arch}: allows read, socket and clone`, () => {
      const allowed = arch === "x64" ? [0, 41, 56] : [63, 198, 220];
      for (const nr of allowed) expect(evaluate(program, table.auditArch, nr)).toBe(ALLOW);
    });

    test(`${arch}: kills the process on a foreign audit arch`, () => {
      expect(evaluate(program, 0x40000003, 11)).toBe(KILL_PROCESS);
    });
  }

  test("x64: denies the x32 ABI range", () => {
    const table = SECCOMP_ARCH_TABLES.x64;
    const program = encodeProgram(buildExecDenyProgram(table));
    expect(evaluate(program, table.auditArch, 0x40000000 + 520)).toBe(EPERM);
    expect(evaluate(program, table.auditArch, 0x40000000)).toBe(EPERM);
  });
});

const FILTER_URL = new URL("../scripts-runtime/sandbox-seccomp.ts", import.meta.url).href;

// The child installs the filter (or not, for the control), then reports what
// spawn and a file read do. Unprivileged: no root or capability needed.
const CHILD = `
const out = {};
if (process.argv[2] === "filter") {
  const { installExecDenyFilter } = await import(${JSON.stringify(FILTER_URL)});
  out.install = await installExecDenyFilter();
}
try {
  out.spawn = await Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" }).exited;
} catch (error) {
  out.spawn = error.code ?? String(error);
}
out.read = (await Bun.file(process.argv[3]).text()).length > 0;
console.log(JSON.stringify(out));
`;

describe.skipIf(process.platform !== "linux" || SKIP_SANDBOX_SPAWN_TESTS)(
  "seccomp exec-deny filter in a real process",
  () => {
    async function probe(mode: "filter" | "control") {
      const dir = await mkdtemp(join(tmpdir(), "seccomp-test-"));
      try {
        await Bun.write(join(dir, "child.ts"), CHILD);
        await Bun.write(join(dir, "data.txt"), "data");
        const result = expectChildOk(
          await runChild(["bun", join(dir, "child.ts"), mode, join(dir, "data.txt")], {
            env: { PATH: process.env.PATH },
          }),
          `seccomp ${mode} child`,
        );
        return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    test(
      "with the filter, spawn gets EPERM and file reads still work",
      async () => {
        const out = await probe("filter");
        expect(out.install).toEqual({ installed: true });
        expect(out.spawn).toBe("EPERM");
        expect(out.read).toBe(true);
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );

    test(
      "control: without the filter, spawn exits 0",
      async () => {
        const out = await probe("control");
        expect(out.spawn).toBe(0);
        expect(out.read).toBe(true);
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );

    test(
      "the native executor installs the filter before user code runs",
      async () => {
        const output = await new NativeScriptExecutor().run(sandboxProbeInput());
        expect(output.error).toBeUndefined();
        expect(output.result).toMatchObject({ spawn: "EPERM" });
        const status = interpretSandboxProbe(output, process.getuid?.());
        expect(status.seccomp).toBe(true);
        // A non-root test process cannot drop uid, so this is never `hardened`.
        if (process.getuid?.() !== 0) expect(status.level).toBe("none");
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );
  },
);

describe("sandbox probe interpretation", () => {
  const ok = (result: unknown) => ({
    result,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
    durationMs: 1,
    exitCode: 0,
  });

  test("a sandbox uid with exec denied is hardened", () => {
    expect(interpretSandboxProbe(ok({ uid: 61002, spawn: "EPERM" }), 0).level).toBe("hardened");
  });

  test("a sandbox uid without the filter is uid-only", () => {
    expect(interpretSandboxProbe(ok({ uid: 61002, spawn: "ok" }), 0).level).toBe("uid-only");
  });

  test("the API's own uid is none, even with the filter", () => {
    const status = interpretSandboxProbe(ok({ uid: 1001, spawn: "EPERM" }), 1001);
    expect(status).toMatchObject({ level: "none", uidDropped: false, seccomp: true });
    expect(interpretSandboxProbe(ok({ uid: 0, spawn: "EPERM" }), 0).level).toBe("none");
  });

  test("a failed probe run is none with the error", () => {
    const status = interpretSandboxProbe({ ...ok(undefined), exitCode: 1, error: "eval_error" }, 0);
    expect(status).toMatchObject({ level: "none", error: "eval_error" });
  });
});
