import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  buildPiResourceLoaderOptions,
  createPiAgentHome,
  OPENROUTER_ATTRIBUTION_HEADERS,
  outpostSystemPromptAppendix,
} from "./agent-home.js";

describe("createPiAgentHome", () => {
  it("gives the session an empty working directory separate from Pi's config", async () => {
    const home = await createPiAgentHome();
    try {
      expect(home.cwd).not.toBe(home.agentDir);
      expect(await readdir(home.cwd)).toEqual([]);
      expect(await readdir(home.agentDir)).toEqual(["models.json"]);
    } finally {
      await home.remove();
    }
  });

  /**
   * The session's key, and the token that fetches it, live in the credential
   * store's memory and nowhere else. Nothing about a credential reaches this
   * directory: the only file is models.json, whose whole content is the
   * public OpenRouter attribution block, so there is no secret to leak, to
   * outlive the session, or to be read by anything the model can reach.
   */
  it("writes no credential of any kind into the session directory", async () => {
    const home = await createPiAgentHome();
    try {
      expect(await readdir(home.agentDir)).toEqual(["models.json"]);
      expect(JSON.parse(await readFile(home.modelsPath, "utf8"))).toEqual({
        providers: { openrouter: { headers: OPENROUTER_ATTRIBUTION_HEADERS } },
      });
      await expect(readFile(home.authPath, "utf8")).rejects.toThrow();
    } finally {
      await home.remove();
    }
  });

  it("attributes OpenRouter usage to the product, not the operator", () => {
    expect(OPENROUTER_ATTRIBUTION_HEADERS["HTTP-Referer"]).toBe("https://openoutposts.com");
    expect(OPENROUTER_ATTRIBUTION_HEADERS["X-OpenRouter-Title"]).toBe("OpenOutposts");
    expect(OPENROUTER_ATTRIBUTION_HEADERS["X-Title"]).toBe("OpenOutposts");
  });

  it("points Pi's auth path inside the session's own directory", async () => {
    const home = await createPiAgentHome();
    try {
      // Nothing writes it, but if anything ever did it must not land in the
      // homestead operator's ~/.pi, shared by every session on the machine.
      expect(home.authPath.startsWith(home.agentDir)).toBe(true);
      expect(home.modelsPath.startsWith(home.agentDir)).toBe(true);
    } finally {
      await home.remove();
    }
  });

  it("removes everything it created", async () => {
    const home = await createPiAgentHome();
    await home.remove();
    await expect(readdir(home.cwd)).rejects.toThrow();
    await expect(readdir(home.agentDir)).rejects.toThrow();
  });
});

describe("buildPiResourceLoaderOptions", () => {
  it("appends outpost instructions naming every remote tool", () => {
    const appended = buildPiResourceLoaderOptions().appendSystemPrompt.join("\n");
    expect(appended).toBe(outpostSystemPromptAppendix);
    for (const tool of [
      "outpost_bash",
      "outpost_read",
      "outpost_write",
      "outpost_edit",
      "outpost_grep",
      "outpost_find",
      "outpost_ls",
    ]) {
      expect(appended).toContain(tool);
    }
  });
});
