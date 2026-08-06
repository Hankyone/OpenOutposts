import { describe, expect, it } from "vitest";

import {
  DiffBudget,
  collectRepositoryDiff,
  buildDiffBundle,
  type WorkspaceHomestead,
} from "./diff-capture.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function fakeHomestead(responses: Array<{ match: RegExp; stdout: string; exitCode?: number }>) {
  const calls: string[] = [];
  const run: WorkspaceHomestead = async (command) => {
    calls.push(command);
    for (const response of responses) {
      if (response.match.test(command)) {
        return {
          ok: true,
          stdout: response.stdout,
          stderr: "",
          exitCode: response.exitCode ?? 0,
        };
      }
    }
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

const identity = { position: 0, repoOwner: "octo", repoName: "demo", baseSha: BASE };

describe("collectRepositoryDiff", () => {
  it("collects modified, renamed, and untracked files with patches", async () => {
    const patch = `diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    const { run } = fakeHomestead([
      { match: /cat-file -e/, stdout: "" },
      { match: /rev-parse HEAD/, stdout: `${HEAD}\n` },
      {
        match: /--raw -z/,
        stdout: `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0src/app.ts\0:100644 100644 ${"3".repeat(40)} ${"4".repeat(40)} R100\0old-name.ts\0new-name.ts\0`,
      },
      { match: /ls-files --others/, stdout: "notes.md\0" },
      {
        match: /--numstat -z --find-renames/,
        stdout: `1\t1\tsrc/app.ts\0${"2\t0\t"}\0old-name.ts\0new-name.ts\0`,
      },
      { match: /--no-index --numstat/, stdout: "5\t0\t/dev/null => notes.md\n" },
      { match: /--unified=1000000/, stdout: patch },
    ]);

    const entry = await collectRepositoryDiff(run, identity, new DiffBudget());
    expect(entry.status).toBe("ready");
    expect(entry.headSha).toBe(HEAD);
    expect(entry.files).toHaveLength(3);

    const [modified, renamed, untracked] = entry.files;
    expect(modified).toMatchObject({
      path: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      renderState: "renderable",
    });
    expect(modified.patch).toContain("@@");
    expect(renamed).toMatchObject({
      path: "new-name.ts",
      oldPath: "old-name.ts",
      status: "renamed",
      additions: 2,
      deletions: 0,
    });
    expect(untracked).toMatchObject({ path: "notes.md", status: "added" });
  });

  it("marks binary files without fetching patches", async () => {
    const { run, calls } = fakeHomestead([
      { match: /cat-file -e/, stdout: "" },
      { match: /rev-parse HEAD/, stdout: `${HEAD}\n` },
      {
        match: /--raw -z/,
        stdout: `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0logo.png\0`,
      },
      { match: /ls-files --others/, stdout: "" },
      { match: /--numstat -z --find-renames/, stdout: `-\t-\tlogo.png\0` },
    ]);

    const entry = await collectRepositoryDiff(run, identity, new DiffBudget());
    expect(entry.files[0]).toMatchObject({
      path: "logo.png",
      renderState: "binary",
      additions: null,
      deletions: null,
    });
    expect(calls.some((command) => command.includes("--unified=1000000"))).toBe(false);
  });

  it("reports the repository unavailable when the baseline is missing", async () => {
    const { run } = fakeHomestead([{ match: /cat-file -e/, stdout: "", exitCode: 1 }]);
    const entry = await collectRepositoryDiff(run, identity, new DiffBudget());
    expect(entry.status).toBe("unavailable");
    expect(entry.error).toContain("baseline");
    expect(entry.files).toHaveLength(0);
  });

  it("flips oversized patches to too_large and respects the file cap", async () => {
    const bigPatch = `diff --git a/big b/big\n@@ -1 +1 @@\n${"+x".repeat(300_000)}\n`;
    const { run } = fakeHomestead([
      { match: /cat-file -e/, stdout: "" },
      { match: /rev-parse HEAD/, stdout: `${HEAD}\n` },
      {
        match: /--raw -z/,
        stdout: `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0big\0`,
      },
      { match: /ls-files --others/, stdout: "" },
      { match: /--numstat -z --find-renames/, stdout: `1\t0\tbig\0` },
      { match: /--unified=1000000/, stdout: bigPatch },
    ]);

    const entry = await collectRepositoryDiff(run, identity, new DiffBudget());
    expect(entry.files[0].renderState).toBe("too_large");
    expect(entry.files[0].patch).toBeUndefined();
  });
});

describe("buildDiffBundle", () => {
  it("produces a version-1 bundle with the trigger id", async () => {
    const { run } = fakeHomestead([
      { match: /cat-file -e/, stdout: "" },
      { match: /rev-parse HEAD/, stdout: `${HEAD}\n` },
      { match: /--raw -z/, stdout: "" },
      { match: /ls-files --others/, stdout: "" },
      { match: /--numstat -z --find-renames/, stdout: "" },
    ]);
    const bundle = await buildDiffBundle(run, [identity], "msg-42");
    expect(bundle.version).toBe(1);
    expect(bundle.triggerMessageId).toBe("msg-42");
    expect(bundle.repositories).toHaveLength(1);
    expect(bundle.repositories[0].status).toBe("ready");
  });
});
