#!/usr/bin/env node
import { runCli } from './cli/commands.js';

runCli(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\x1b[31m✗\x1b[0m ${message}`);
  process.exitCode = 1;
});
