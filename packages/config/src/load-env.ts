import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Dotenv loader — the missing half of "Secrets via env only".
 *
 * `packages/config/src/env.ts` validates `process.env`, but nothing ever *populated*
 * `process.env` from the `.env` files the repository documents. Running `pnpm dev`
 * therefore produced "Invalid environment: missing required variable(s) DATABASE_URL,
 * JWT_PRIVATE_KEY, JWT_PUBLIC_KEY" even with a perfectly good `.env` on disk.
 *
 * Rules (deliberately the same ones Next.js and dotenv-flow use, so the two halves of
 * the monorepo behave identically):
 *
 *  1. A variable that already exists in the real process environment always wins.
 *     Nothing here ever overwrites what Docker/CI/systemd injected.
 *  2. Files are searched from the current working directory upwards to the workspace
 *     root, so `apps/api/.env` overrides `<repo>/.env` which overrides
 *     `<repo>/infrastructure/env/.env`.
 *  3. Per directory the order is `.env.<NODE_ENV>.local` > `.env.local` >
 *     `.env.<NODE_ENV>` > `.env`.
 *  4. Loading is idempotent and never throws: a malformed line is skipped and reported
 *     through `loadedEnvFiles()` instead of crashing the boot.
 */

export type LoadedEnvFile = {
  path: string;
  keys: string[];
};

const loaded: LoadedEnvFile[] = [];
let done = false;

/** Files that were actually read, nearest-first. Useful for a boot diagnostic line. */
export function loadedEnvFiles(): readonly LoadedEnvFile[] {
  return loaded;
}

function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Normalise CRLF so a file authored on Windows does not leave "\r" glued to a secret.
  for (const rawLine of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // Double quotes: honour the usual escape sequences so a PEM key can be written
      // on a single line as "-----BEGIN…\n…".
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment is only a comment when it follows whitespace,
      // otherwise `PASSWORD=a#b` would silently lose half the secret.
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }

    result[key] = value;
  }
  return result;
}

function readMultiline(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, 'utf8');
  // Multi-line double-quoted values (a pasted PEM block) are joined before parsing.
  const joined = content.replace(/^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*"([\s\S]*?)"\s*$/gm, (_match, key: string, body: string) =>
    `${key}="${body.replace(/\r?\n/g, '\\n')}"`,
  );
  return parseDotenv(joined);
}

function candidateDirectories(startDir: string): string[] {
  const directories: string[] = [];
  let current = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    // Stop climbing once we are above the workspace root.
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      directories.push(current);
      break;
    }
  }
  return [...new Set(directories)];
}

function workspaceRoot(startDir: string): string | undefined {
  return candidateDirectories(startDir).find((directory) => existsSync(join(directory, 'pnpm-workspace.yaml')));
}

export type LoadEnvOptions = {
  cwd?: string;
  /** Re-read the files even when a previous call already ran (tests). */
  force?: boolean;
  /** Target object; defaults to `process.env`. */
  target?: Record<string, string | undefined>;
};

export function loadEnvFiles(options: LoadEnvOptions = {}): readonly LoadedEnvFile[] {
  if (done && !options.force) return loaded;
  done = true;
  if (options.force) loaded.length = 0;

  const target = options.target ?? (process.env as Record<string, string | undefined>);
  const cwd = options.cwd ?? process.cwd();
  const nodeEnv = target.NODE_ENV ?? 'development';

  const directories = candidateDirectories(cwd);
  const root = workspaceRoot(cwd);
  // The infra template directory is the documented home of the shared local stack values.
  if (root) directories.push(join(root, 'infrastructure', 'env'));

  const fileNames = [`.env.${nodeEnv}.local`, '.env.local', `.env.${nodeEnv}`, '.env'];

  for (const directory of directories) {
    for (const fileName of fileNames) {
      const filePath = join(directory, fileName);
      if (!existsSync(filePath)) continue;

      let values: Record<string, string>;
      try {
        values = readMultiline(filePath);
      } catch {
        continue;
      }

      const applied: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        // Nearest file wins, and a real environment variable always wins.
        if (target[key] !== undefined) continue;
        target[key] = value;
        applied.push(key);
      }
      loaded.push({ path: filePath, keys: applied });
    }
  }

  return loaded;
}

/** One-line summary for the boot log — never prints a value, only file paths and counts. */
export function describeEnvSources(): string {
  if (loaded.length === 0) return 'no .env file found (using the real process environment only)';
  return loaded.map((file) => `${file.path} (+${file.keys.length})`).join(', ');
}
