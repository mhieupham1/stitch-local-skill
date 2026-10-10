import { cwd } from 'node:process';

export type Parsed = {
  positionals: string[];
  workspace: string;
  json: boolean;
  open: boolean;
  port?: number;
  options: Map<string, string>;
};

export function parseArguments(argv: string[]): Parsed {
  const parsed: Parsed = { positionals: [], workspace: cwd(), json: false, open: false, options: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--workspace') parsed.workspace = argv[++index] ?? '';
    else if (argument === '--json') parsed.json = true;
    else if (argument === '--open') parsed.open = true;
    else if (argument === '--port') parsed.port = Number(argv[++index]);
    else if (argument.startsWith('--')) parsed.options.set(argument, argv[++index] ?? '');
    else parsed.positionals.push(argument);
  }
  return parsed;
}

export function option(parsed: Parsed, name: string): string {
  const value = parsed.options.get(name);
  if (!value) throw new Error(`Thiếu ${name}.`);
  return value;
}

export function integerOption(parsed: Parsed, name: string): number {
  const value = Number(option(parsed, name));
  if (!Number.isInteger(value)) throw new Error(`${name} phải là số nguyên.`);
  return value;
}
