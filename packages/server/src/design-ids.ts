import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { parse } from 'parse5';
import { getProjectRoot, readProject } from '../../core/src/project-store.js';
import { resolveProjectFile } from '../../core/src/paths.js';
import { CanvasError } from '../../core/src/schema.js';

type HtmlNode = {
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: {
    startTag?: { endOffset: number };
    attrs?: Record<string, { startOffset: number; endOffset: number }>;
  };
};

function walk(node: HtmlNode, visit: (node: HtmlNode) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

/** Add stable IDs to source tags without serializing (and reformatting) the HTML. */
export function addDesignIds(html: string, screenId: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true }) as HtmlNode;
  const ids = new Set<string>();
  let body: HtmlNode | undefined;
  walk(document, (node) => {
    if (node.tagName === 'body') body = node;
    for (const attr of node.attrs ?? []) if (attr.name === 'data-design-id' && attr.value) ids.add(attr.value);
  });
  if (!body) return html;

  const edits: { start: number; end: number; text: string }[] = [];
  const seen = new Set<string>();
  const collectOutsideBody = (node: HtmlNode): void => {
    if (node === body) return;
    for (const attr of node.attrs ?? []) if (attr.name === 'data-design-id' && attr.value) seen.add(attr.value);
    for (const child of node.childNodes ?? []) collectOutsideBody(child);
    if (node.content) collectOutsideBody(node.content);
  };
  collectOutsideBody(document);
  let sequence = 1;
  walk(body, (node) => {
    if (!node.tagName || !node.sourceCodeLocation?.startTag) return;
    const current = node.attrs?.find((attr) => attr.name === 'data-design-id');
    if (current?.value && !seen.has(current.value)) { seen.add(current.value); return; }
    let id: string;
    do { id = `${screenId}-el-${sequence++}`; } while (ids.has(id));
    ids.add(id);
    seen.add(id);

    if (current) {
      const location = node.sourceCodeLocation.attrs?.['data-design-id'];
      if (!location) return;
      edits.push({ start: location.startOffset, end: location.endOffset, text: `data-design-id="${id}"` });
      return;
    }
    const tagEnd = node.sourceCodeLocation.startTag.endOffset;
    const beforeClose = html.lastIndexOf('>', tagEnd - 1);
    if (beforeClose < 0) return;
    let offset = beforeClose;
    if (html[offset - 1] === '/') offset -= 1;
    while (offset > 0 && /\s/.test(html[offset - 1])) offset -= 1;
    edits.push({ start: offset, end: offset, text: ` data-design-id="${id}"` });
  });

  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    html = `${html.slice(0, edit.start)}${edit.text}${html.slice(edit.end)}`;
  }
  return html;
}

export async function ensureDesignIds(workspace: string, projectId: string, screenId: string): Promise<void> {
  const project = await readProject(workspace, projectId);
  const screen = project.screens.find((item) => item.id === screenId);
  if (!screen) throw new CanvasError('SCREEN_NOT_FOUND', `Không tìm thấy màn hình “${screenId}”.`, 404);
  const root = await getProjectRoot(workspace, projectId);
  const file = await resolveProjectFile(root, screen.entry);
  if (!file.endsWith('.html')) return;
  const original = await readFile(file, 'utf8');
  const tagged = addDesignIds(original, screenId);
  if (tagged === original) return;
  // The editor may save the source while the user enters edit mode.
  const metadata = await stat(file);
  const temporary = join(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, tagged, { mode: metadata.mode, flag: 'wx' });
    if (await readFile(file, 'utf8') !== original) throw new CanvasError('SOURCE_CHANGED', 'HTML vừa thay đổi; hãy bấm Chỉnh sửa lại.', 409);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
