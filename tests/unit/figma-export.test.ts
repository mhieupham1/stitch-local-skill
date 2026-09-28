import { describe, expect, it } from 'vitest';
import { serializeForFigma, type ExtractedNode } from '../../packages/server/src/figma-export.js';

const node = (over: Partial<ExtractedNode> = {}): ExtractedNode => ({
  tag: 'div', style: {}, text: '', x: 0, y: 0, children: [], ...over,
});

describe('serializeForFigma', () => {
  it('đặt mọi phần tử bằng toạ độ tuyệt đối để Figma dựng được khung', () => {
    // Figma bỏ qua flex/grid, nên định vị tuyệt đối là thứ duy nhất giữ được layout.
    const html = serializeForFigma(node({ style: { 'background-color': 'rgb(99, 102, 241)' } }));
    expect(html).toContain('position:absolute');
    expect(html).toContain('left:0px');
    expect(html).toContain('top:0px');
    expect(html).toContain('background-color:rgb(99, 102, 241)');
  });

  it('quy toạ độ con về gốc của cha, không phải gốc trang', () => {
    // Nếu neo tất cả vào gốc trang thì các phần tử sẽ chồng lên nhau.
    const parent = node({ x: 100, y: 50, children: [node({ tag: 'span', x: 140, y: 80 })] });
    const html = serializeForFigma(parent);
    expect(html).toContain('<span style="position:absolute;left:40px;top:30px">');
  });

  it('toạ độ chồng sâu nhiều tầng vẫn cộng dồn đúng', () => {
    const tree = node({ x: 10, y: 10, children: [
      node({ tag: 'section', x: 30, y: 40, children: [node({ tag: 'p', x: 55, y: 100, text: 'x' })] }),
    ] });
    const html = serializeForFigma(tree);
    expect(html).toContain('<section style="position:absolute;left:20px;top:30px">');
    expect(html).toContain('<p style="position:absolute;left:25px;top:60px">x</p>');
  });

  it('giữ cây lồng nhau và text node đúng thứ tự', () => {
    const html = serializeForFigma(node({
      tag: 'main',
      children: [
        node({ tag: 'h1', style: { 'font-size': '28px' }, text: 'Tiêu đề' }),
        node({ tag: 'button', text: 'Tạo đơn' }),
      ],
    }));
    expect(html).toBe(
      '<main style="position:absolute;left:0px;top:0px">'
      + '<h1 style="position:absolute;left:0px;top:0px;font-size:28px">Tiêu đề</h1>'
      + '<button style="position:absolute;left:0px;top:0px">Tạo đơn</button></main>',
    );
  });

  it('escape ký tự đặc biệt trong cả thuộc tính lẫn nội dung', () => {
    const html = serializeForFigma(node({ style: { 'font-family': 'A"B' }, text: 'a < b & c > d' }));
    expect(html).toContain('font-family:A&quot;B');
    expect(html).toContain('>a &lt; b &amp; c &gt; d<');
  });

  it('luôn ghi style kể cả khi không có khai báo nào, để giữ định vị', () => {
    const html = serializeForFigma(node({ tag: 'span', text: 'x' }));
    expect(html).toBe('<span style="position:absolute;left:0px;top:0px">x</span>');
  });
});
