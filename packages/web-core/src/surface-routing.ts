/**
 * AUD-13 — surface classification by whole path segment, never a raw prefix match.
 *
 * The original `AuthGate` used `startsWith('/m')` / `startsWith('/esign')`, so
 * `/marina`, `/migration` and `/manufacturing` were wrapped by the employee shell, and
 * `/esign-evil` slipped past the gate into a public page. The rule: the pathname equals
 * the prefix, or is followed by `/`. Pure function so it can be tested without a
 * browser; each app keeps its own list of prefixes.
 */
export function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
