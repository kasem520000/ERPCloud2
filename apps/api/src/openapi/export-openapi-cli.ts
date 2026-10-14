import { writeOpenApiSpec } from './export-openapi.js';

/** Entry point for `pnpm openapi:export` (runs against the compiled output). */
writeOpenApiSpec(process.argv[2])
  .then((file) => {
    console.log(`OpenAPI document written to ${file}`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
