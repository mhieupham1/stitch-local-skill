/**
 * Điểm mấu chốt: nếu `commandsBlob` là 1-based thì blobs[0] KHÔNG BAO GIỜ được
 * trỏ tới, và blobs[blobs.length-1] luôn nằm ngoài mảng khi ta đọc.
 * Nếu 0-based thì blobs[0] phải có ít nhất một glyph trỏ tới.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '/Users/hieu/WebstormProjects/stitch-local-skill/packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '/Users/hieu/WebstormProjects/stitch-local-skill/packages/server/src/figma/clipboard.ts';

for (const path of process.argv.slice(2)) {
  const parsed = parseFigmaClipboardHtml(readFileSync(path, 'utf8'))!;
  const unpacked = unpackArchive(new Uint8Array(parsed.archive));
  const msg = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
  const blobs = (msg.blobs ?? []) as Array<{ bytes: Uint8Array }>;
  const changes = (msg.nodeChanges ?? []) as Array<Record<string, any>>;

  const used = new Set<number>();
  let glyphCount = 0;
  for (const node of changes) {
    if (node.type === 'TEXT') {
      for (const g of (node.derivedTextData?.glyphs ?? []) as Array<Record<string, any>>) {
        if (typeof g.commandsBlob === 'number') { used.add(g.commandsBlob); glyphCount++; }
      }
    }
    if (typeof node.vectorData?.vectorNetworkBlob === 'number') used.add(node.vectorData.vectorNetworkBlob);
    for (const p of (node.fillPaints ?? []) as Array<Record<string, any>>) {
      if (typeof p.image?.dataBlob === 'number') used.add(p.image.dataBlob);
    }
    for (const g of (node.fillGeometry ?? []) as Array<Record<string, any>>) {
      if (typeof g.commandsBlob === 'number') used.add(g.commandsBlob);
    }
  }

  const sorted = [...used].sort((a, b) => a - b);
  console.log('### ' + path.split('/').pop());
  console.log('  blobs:', blobs.length, '| chỉ số được trỏ tới:', used.size, '| glyph:', glyphCount);
  console.log('  nhỏ nhất:', sorted[0], '| lớn nhất:', sorted[sorted.length - 1]);
  console.log('  có blob nào trỏ tới 0 không?', used.has(0) ? 'CÓ -> 0-based' : 'KHÔNG');
  console.log('  có chỉ số >= blobs.length không?', sorted[sorted.length - 1] >= blobs.length ? 'CÓ -> 1-based (vượt mảng)' : 'KHÔNG');
  console.log('  blob[0] dài:', blobs[0]?.bytes?.length, 'byte | blob cuối dài:', blobs[blobs.length - 1]?.bytes?.length);
  console.log();
}
