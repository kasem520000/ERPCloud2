/**
 * Join class names, dropping the falsy ones.
 *
 * Deliberately tiny — the repo already forbids new dependencies (§8.4), and
 * every call site in this package passes a mixture of static strings and
 * conditionals, which is exactly what a 20-line joiner is for.
 */
export type ClassValue = string | number | bigint | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  let out = '';
  for (const value of values) {
    if (!value) continue;
    const next = typeof value === 'string' ? value : String(value);
    out = out ? `${out} ${next}` : next;
  }
  return out;
}
