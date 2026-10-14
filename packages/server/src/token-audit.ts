import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectRoot, readProject } from '../../core/src/project-store.js';

/**
 * Design-token audit.
 *
 * The runtime asks the agent to put shared colors, spacing, fonts and radii in
 * `design-system.css` and to reference them from each screen instead of
 * repeating literals. Nothing checked that, and drift is invisible by nature:
 * one screen drifting from the token set looks fine on its own and only reads
 * as inconsistent next to the others — which is exactly the failure a set of
 * agent-generated screens produces. This reports the drift so the agent can fix
 * it before calling the work done.
 *
 * It reads the source files rather than the rendered page. The source is what
 * the agent edits, so a finding can name the file and line to change, and no
 * browser is needed to get an answer.
 */

export type TokenFinding = {
  severity: 'error' | 'warning' | 'info';
  kind: 'broken-reference' | 'hardcoded-color' | 'hardcoded-font' | 'off-scale-spacing' | 'duplicate-token' | 'unused-token';
  file: string;
  line: number;
  message: string;
  value: string;
};

export type TokenReport = {
  tokens: { name: string; value: string }[];
  findings: TokenFinding[];
  summary: { errors: number; warnings: number; infos: number; truncated: number };
};

/** Caps each kind so one messy screen cannot bury the rest of the report. */
const MAX_PER_KIND = 30;

/** Values that are legitimately literal everywhere and must never be reported. */
const COLOR_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none', 'auto']);

/**
 * Replaces comments and string literals with spaces, keeping every other
 * character at its original offset so line numbers stay correct. Without this a
 * `var(--x)` inside a comment or an `url("…")` reads as a real reference.
 */
export function blankCommentsAndStrings(css: string): string {
  const out = [...css];
  let index = 0;
  const blank = (from: number, to: number) => {
    for (let at = from; at < to && at < out.length; at += 1) if (out[at] !== '\n') out[at] = ' ';
  };
  while (index < css.length) {
    const pair = css.slice(index, index + 2);
    if (pair === '/*') {
      const end = css.indexOf('*/', index + 2);
      const stop = end === -1 ? css.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    const quote = css[index];
    if (quote === '"' || quote === "'") {
      let at = index + 1;
      while (at < css.length && css[at] !== quote) at += css[at] === '\\' ? 2 : 1;
      blank(index, Math.min(at + 1, css.length));
      index = at + 1;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/**
 * Blanks at-rule preludes (`@media (min-width: 600px)`, `@import "x.css";`) so
 * the declaration scanner does not read a media feature as a property.
 */
export function blankAtRulePreludes(css: string): string {
  return css.replace(/@[^{;]*(?=[{;])/g, (match) => match.replace(/[^\n]/g, ' '));
}

export type Declaration = { name: string; value: string; line: number };

const lineAt = (css: string, offset: number): number => css.slice(0, offset).split('\n').length;

/** Every `name: value` pair, in source order, with 1-based line numbers. */
export function findDeclarations(css: string): Declaration[] {
  const scanned = blankAtRulePreludes(blankCommentsAndStrings(css));
  const declarations: Declaration[] = [];
  for (const match of scanned.matchAll(/(^|[;{}])\s*([a-zA-Z-][\w-]*)\s*:\s*([^;{}]+)/g)) {
    const name = match[2];
    const nameAt = match.index + match[0].indexOf(name);
    // The blanked copy decides where the declaration starts and ends; the value
    // is read from the original so a quoted string survives. Reading the blanked
    // copy instead would drop `font-family: "Inter"` as an empty value and hide
    // the very literal this audit exists to find.
    const valueAt = match.index + match[0].indexOf(':', match[0].indexOf(name)) + 1;
    const value = css.slice(valueAt, match.index + match[0].length).trim();
    if (value.length === 0) continue;
    declarations.push({ name, value, line: lineAt(scanned, nameAt) });
  }
  return declarations;
}

/** Custom properties declared anywhere in the file. */
export function findTokenDeclarations(css: string): Declaration[] {
  return findDeclarations(css).filter((declaration) => declaration.name.startsWith('--'));
}

export type TokenReference = { name: string; hasFallback: boolean; line: number };

export function findTokenReferences(css: string): TokenReference[] {
  const scanned = blankAtRulePreludes(blankCommentsAndStrings(css));
  const references: TokenReference[] = [];
  for (const match of scanned.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    references.push({ name: match[1], hasFallback: match[2] === ',', line: lineAt(scanned, match.index) });
  }
  return references;
}

const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/g;

/** Color literals in a value, skipping anything written inside a `var()` fallback. */
export function findColorLiterals(value: string): string[] {
  const withoutVarCalls = value.replace(/var\([^)]*\)/g, ' ');
  const found = [...withoutVarCalls.matchAll(COLOR_PATTERN)].map((match) => match[0]);
  return found.filter((literal) => !COLOR_KEYWORDS.has(literal.toLowerCase()));
}

const SPACING_PROPERTY = /^(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$/;
const PX_LENGTH = /(-?\d*\.?\d+)px/g;

/** Pixel lengths in a spacing value. Percentages, rem, em and 0 are not lengths on a scale. */
export function findSpacingLengths(value: string): string[] {
  const withoutFunctions = value.replace(/(?:calc|clamp|min|max|var)\([^)]*\)/g, ' ');
  return [...withoutFunctions.matchAll(PX_LENGTH)].map((match) => match[0]);
}

export const isSpacingProperty = (name: string): boolean => SPACING_PROPERTY.test(name);

export type SourceFile = { path: string; content: string };

/** `#f5f5f5` and `#F5F5F5` are the same token value; `0px` and `0` are not. */
const normalizeColor = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '');

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    // A screen may have no styles.css at all; that is not an audit failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Every `.css` file directly in a directory, plus the given entry HTML. */
async function screenSources(root: string, screenId: string, entry: string): Promise<SourceFile[]> {
  const directory = join(root, 'screens', screenId);
  const files: SourceFile[] = [];
  const entryPath = join(root, entry);
  const html = await readIfPresent(entryPath);
  if (html !== null) files.push({ path: entry, content: html });
  let names: string[] = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.css')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of names) {
    const path = `screens/${screenId}/${name}`;
    const content = await readIfPresent(join(directory, name));
    if (content !== null) files.push({ path, content });
  }
  return files;
}

export async function auditDesignTokens(workspace: string, projectId: string): Promise<TokenReport> {
  const project = await readProject(workspace, projectId);
  const root = await getProjectRoot(workspace, projectId);

  const designSystem = (await readIfPresent(join(root, 'design-system.css'))) ?? '';
  const designSystemTokens = findTokenDeclarations(designSystem);
  const declared = new Set(designSystemTokens.map((token) => token.name));

  const findings: TokenFinding[] = [];
  const push = (finding: TokenFinding) => { findings.push(finding); };

  // Duplicate values: two names for one decision, which is how a token set stops
  // being a scale and becomes a list of aliases.
  const byValue = new Map<string, string[]>();
  for (const token of designSystemTokens) {
    const key = normalizeColor(token.value);
    byValue.set(key, [...(byValue.get(key) ?? []), token.name]);
  }
  for (const [value, names] of byValue) {
    if (names.length < 2) continue;
    push({
      severity: 'info',
      kind: 'duplicate-token',
      file: 'design-system.css',
      line: designSystemTokens.find((token) => token.name === names[0])?.line ?? 1,
      message: `${names.length} token cùng giá trị: ${names.join(', ')}.`,
      value,
    });
  }

  const usedEverywhere = new Set<string>();
  const spacingScale = new Set(
    designSystemTokens
      .flatMap((token) => findSpacingLengths(token.value))
      .map((length) => length.replace('px', '')),
  );

  for (const screen of project.screens) {
    for (const file of await screenSources(root, screen.id, screen.entry)) {
      const localTokens = new Set(findTokenDeclarations(file.content).map((token) => token.name));
      for (const reference of findTokenReferences(file.content)) {
        usedEverywhere.add(reference.name);
        if (declared.has(reference.name) || localTokens.has(reference.name)) continue;
        push({
          severity: reference.hasFallback ? 'warning' : 'error',
          kind: 'broken-reference',
          file: file.path,
          line: reference.line,
          message: reference.hasFallback
            ? `${reference.name} không được khai báo; đang dùng giá trị dự phòng.`
            : `${reference.name} không được khai báo trong design-system.css.`,
          value: reference.name,
        });
      }
      for (const declaration of findDeclarations(file.content)) {
        if (declaration.name.startsWith('--')) continue;
        for (const literal of findColorLiterals(declaration.value)) {
          const matching = byValue.get(normalizeColor(literal)) ?? [];
          push({
            severity: 'warning',
            kind: 'hardcoded-color',
            file: file.path,
            line: declaration.line,
            message: matching.length > 0
              ? `${declaration.name}: ${literal} trùng giá trị của ${matching.join(', ')} — hãy dùng var().`
              : `${declaration.name}: ${literal} là màu cứng, chưa có token nào mang giá trị này.`,
            value: literal,
          });
        }
        if (declaration.name === 'font-family' && !/^var\(/.test(declaration.value)) {
          push({
            severity: 'warning',
            kind: 'hardcoded-font',
            file: file.path,
            line: declaration.line,
            message: `font-family viết cứng (${declaration.value}); hãy khai báo một token font trong design-system.css.`,
            value: declaration.value,
          });
        }
        if (!isSpacingProperty(declaration.name) || spacingScale.size === 0) continue;
        for (const length of findSpacingLengths(declaration.value)) {
          const bare = length.replace('px', '');
          if (bare === '0' || spacingScale.has(bare)) continue;
          push({
            severity: 'info',
            kind: 'off-scale-spacing',
            file: file.path,
            line: declaration.line,
            message: `${declaration.name}: ${length} không nằm trên thang khoảng cách (${[...spacingScale].map(Number).sort((a, b) => a - b).join(', ')}px).`,
            value: length,
          });
        }
      }
    }
  }

  for (const token of designSystemTokens) {
    if (usedEverywhere.has(token.name)) continue;
    push({
      severity: 'info',
      kind: 'unused-token',
      file: 'design-system.css',
      line: token.line,
      message: `${token.name} không được màn hình nào dùng.`,
      value: token.name,
    });
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((left, right) => order[left.severity] - order[right.severity] || left.file.localeCompare(right.file) || left.line - right.line);

  // Cap per kind after sorting, so the cap keeps the most severe of each kind.
  const perKind = new Map<string, number>();
  const kept: TokenFinding[] = [];
  let truncated = 0;
  for (const finding of findings) {
    const seen = perKind.get(finding.kind) ?? 0;
    if (seen >= MAX_PER_KIND) { truncated += 1; continue; }
    perKind.set(finding.kind, seen + 1);
    kept.push(finding);
  }

  return {
    tokens: designSystemTokens.map((token) => ({ name: token.name, value: token.value })),
    findings: kept,
    summary: {
      errors: kept.filter((finding) => finding.severity === 'error').length,
      warnings: kept.filter((finding) => finding.severity === 'warning').length,
      infos: kept.filter((finding) => finding.severity === 'info').length,
      truncated,
    },
  };
}
