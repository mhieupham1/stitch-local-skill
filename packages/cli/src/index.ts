#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { asCanvasError, type Result } from '../../core/src/schema.js';
import type { RuntimeInfo } from '../../server/src/lifecycle.js';
import { parseArguments } from './args.js';
import { matchCommand, usage } from './commands.js';

function writeResult<T>(result: Result<T>, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.ok) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  else process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
}

export function canvasOpenUrl(runtime: RuntimeInfo): string {
  const url = new URL(runtime.url);
  url.hash = new URLSearchParams({ previewUrl: runtime.previewUrl }).toString();
  return url.toString();
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArguments(argv);
  try {
    const matched = matchCommand(args.positionals);
    if (!matched) throw new Error(usage());
    const data = await matched.spec.run({ args, rest: matched.rest });
    writeResult({ ok: true, data }, args.json);
    return 0;
  } catch (error) {
    const canvasError = asCanvasError(error);
    writeResult({ ok: false, error: { code: canvasError.code, message: canvasError.message } }, args.json);
    return 1;
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (import.meta.url === invokedFile) {
  process.exitCode = await run(process.argv.slice(2));
}
