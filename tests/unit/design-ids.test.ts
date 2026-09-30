import { describe, expect, it } from 'vitest';
import { addDesignIds } from '../../packages/server/src/design-ids.js';

describe('addDesignIds', () => {
  it('sửa ID rỗng hoặc trùng mà giữ ID hợp lệ đầu tiên', () => {
    const source = '<body><p data-design-id="same">A</p><p data-design-id="same">B</p><button data-design-id="">C</button><img src="logo.svg" /></body>';
    const tagged = addDesignIds(source, 'demo');

    expect(tagged).toContain('<p data-design-id="same">A</p>');
    expect(tagged).toMatch(/<p data-design-id="demo-el-\d+">B<\/p>/);
    expect(tagged).toMatch(/<button data-design-id="demo-el-\d+">C<\/button>/);
    expect(tagged).toMatch(/<img src="logo.svg" data-design-id="demo-el-\d+" \/>/);
    const ids = [...tagged.matchAll(/data-design-id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(addDesignIds(tagged, 'demo')).toBe(tagged);
  });

  it('không giữ ID trùng với head và gắn ID cho phần tử trong template', () => {
    const source = '<html><head><meta data-design-id="same"></head><body><p data-design-id="same">Body</p><template><span>Later</span></template></body></html>';
    const tagged = addDesignIds(source, 'demo');

    expect(tagged).toContain('<meta data-design-id="same">');
    expect(tagged).toMatch(/<p data-design-id="demo-el-\d+">Body<\/p>/);
    expect(tagged).toMatch(/<span data-design-id="demo-el-\d+">Later<\/span>/);
    const ids = [...tagged.matchAll(/data-design-id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
