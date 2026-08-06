import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { shellQuote } from "./shell.js";

/**
 * Ask a real shell what it makes of the quoted value.
 *
 * `shellQuote` is the only barrier between user-controlled text and `sh -c` on
 * someone's machine: branch names, remote URLs, file paths, and the git author
 * name and email that come from a source-control profile. Asserting against a
 * hand-written expected string would only prove the function agrees with
 * itself, so these go through `/bin/sh` and compare what comes back.
 */
function roundTrip(value: string): string {
  return execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`]).toString();
}

describe("shellQuote", () => {
  it("returns ordinary text unchanged", () => {
    expect(roundTrip("main")).toBe("main");
    expect(roundTrip("feature/add-thing")).toBe("feature/add-thing");
    expect(roundTrip("Ada Lovelace")).toBe("Ada Lovelace");
  });

  it.each([
    ["closing quote and a second command", `'; touch /tmp/oo-shellquote-probe; echo '`],
    ["command substitution", `$(touch /tmp/oo-shellquote-probe)`],
    ["backtick substitution", "`touch /tmp/oo-shellquote-probe`"],
    ["variable expansion", "$HOME and ${PATH}"],
    ["a newline carrying its own command", "first\ntouch /tmp/oo-shellquote-probe\n"],
    ["mixed quoting and escapes", `a'b"c\\d$e\`f`],
    ["an escaped quote before a comment", `\\'; touch /tmp/oo-shellquote-probe; #`],
    ["semicolons and pipes", "a; b | c && d || e"],
  ])("passes %s through as data, not as syntax", (_label, value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it("survives being interpolated more than once in one command line", () => {
    const name = `Ada '; touch /tmp/oo-shellquote-probe; echo '`;
    const email = `$(whoami)@example.com`;
    const output = execFileSync("/bin/sh", [
      "-c",
      `printf '%s|%s' ${shellQuote(name)} ${shellQuote(email)}`,
    ]).toString();
    expect(output).toBe(`${name}|${email}`);
  });

  it("quotes an empty string into something the shell still reads as one argument", () => {
    const output = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote("")}x`]).toString();
    expect(output).toBe("x");
  });
});
