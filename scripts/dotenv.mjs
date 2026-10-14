/**
 * Plain-JS twin of `packages/config/src/load-env.ts`.
 *
 * `next.config.mjs` is evaluated by Next.js before any workspace TypeScript is built,
 * so it cannot import `@erp/config`. Both files implement the same rules; keep them in
 * sync when the precedence order changes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function parseDotenv(content) {
  const result = {};
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
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    result[key] = value;
  }
  return result;
}

function candidateDirectories(startDir) {
  const directories = [];
  let current = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      directories.push(current);
      break;
    }
  }
  return [...new Set(directories)];
}

/** Populates `process.env` from the workspace `.env` files without ever overriding it. */
export function loadEnvFiles(cwd = process.cwd()) {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const directories = candidateDirectories(cwd);
  const root = directories.find((directory) => existsSync(join(directory, 'pnpm-workspace.yaml')));
  if (root) directories.push(join(root, 'infrastructure', 'env'));

  const files = [`.env.${nodeEnv}.local`, '.env.local', `.env.${nodeEnv}`, '.env'];
  const loaded = [];

  for (const directory of directories) {
    for (const fileName of files) {
      const filePath = join(directory, fileName);
      if (!existsSync(filePath)) continue;
      let values;
      try {
        const raw = readFileSync(filePath, 'utf8').replace(
          /^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*"([\s\S]*?)"\s*$/gm,
          (_match, key, body) => `${key}="${body.replace(/\r?\n/g, '\\n')}"`,
        );
        values = parseDotenv(raw);
      } catch {
        continue;
      }
      for (const [key, value] of Object.entries(values)) {
        if (process.env[key] !== undefined) continue;
        process.env[key] = value;
      }
      loaded.push(filePath);
    }
  }

  return loaded;
}

export default loadEnvFiles;
