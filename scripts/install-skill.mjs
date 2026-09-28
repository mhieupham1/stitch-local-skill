import { access, cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const targetIndex = process.argv.indexOf('--target');
if (targetIndex === -1 || !process.argv[targetIndex + 1]) throw new Error('Usage: node scripts/install-skill.mjs --target <directory>');
const target = resolve(process.argv[targetIndex + 1]);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'dist', 'release', 'local-design-canvas');
try { await access(target); } catch { throw new Error(`Target does not exist: ${target}`); }
try { await access(source); } catch { throw new Error('Release bundle not found. Run npm run build first.'); }
const destination = join(target, 'local-design-canvas');
try { await access(destination); throw new Error(`Refusing to overwrite existing skill: ${destination}`); } catch (error) { if (!String(error).includes('ENOENT')) throw error; }
await mkdir(target, { recursive: true });
await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
process.stdout.write(`${join(destination, 'SKILL.md')}\n`);
