/**
 * Single-quote shell escaping: the only safe way to interpolate untrusted
 * values (branch names, URLs, paths) into `sh -c` commands. Double-quoted
 * strings still expand `$`, backticks, and `\` — never use them for data.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
