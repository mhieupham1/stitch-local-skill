import { describe, expect, it } from 'vitest';
import {
  blankAtRulePreludes,
  blankCommentsAndStrings,
  findColorLiterals,
  findDeclarations,
  findSpacingLengths,
  findTokenDeclarations,
  findTokenReferences,
  isSpacingProperty,
} from '../../packages/server/src/token-audit.js';

describe('blankCommentsAndStrings', () => {
  it('giữ nguyên độ dài để số dòng không lệch', () => {
    const css = 'a {\n  /* x */\n  color: red;\n}';
    const blanked = blankCommentsAndStrings(css);
    expect(blanked).toHaveLength(css.length);
    expect(blanked.split('\n')).toHaveLength(4);
  });

  it('xoá nội dung comment nhưng giữ ký tự xuống dòng', () => {
    // `/* a` and `b */` are four characters each, so each becomes four spaces.
    expect(blankCommentsAndStrings('/* a\nb */color:red')).toBe('    \n    color:red');
  });

  it('xoá cả comment chưa đóng', () => {
    expect(blankCommentsAndStrings('a{} /* chưa đóng')).toBe('a{}             ');
  });

  it('xoá chuỗi, kể cả khi chứa dấu ngoặc hoặc dấu chấm phẩy', () => {
    expect(blankCommentsAndStrings('content: "; }"')).toBe('content:      ');
  });

  it('xử lý được dấu nháy đã escape trong chuỗi', () => {
    // `content: "a\"b"` — the escaped quote is inside the string, so the whole
    // literal is blanked and nothing after it is mistaken for code.
    expect(blankCommentsAndStrings(String.raw`content: "a\"b"`)).toBe('content:       ');
  });

  it('để nguyên dấu nháy đơn không đóng ở cuối', () => {
    expect(() => blankCommentsAndStrings("content: 'x")).not.toThrow();
  });
});

describe('blankAtRulePreludes', () => {
  it('không đọc media feature thành thuộc tính', () => {
    const css = blankAtRulePreludes('@media (min-width: 600px) { a { color: red } }');
    expect(findDeclarations(css).map((declaration) => declaration.name)).toEqual(['color']);
  });

  it('bỏ qua @import', () => {
    expect(findDeclarations(blankAtRulePreludes('@import url("x.css");\na{color:red}')).map((d) => d.name)).toEqual(['color']);
  });
});

describe('findDeclarations', () => {
  it('trả về tên, giá trị và số dòng', () => {
    const declarations = findDeclarations('a {\n  color: red;\n  --gap: 8px;\n}');
    expect(declarations).toEqual([
      { name: 'color', value: 'red', line: 2 },
      { name: '--gap', value: '8px', line: 3 },
    ]);
  });

  it('đọc được khai báo lồng trong nhiều block', () => {
    const names = findDeclarations('.a{color:red}.b{padding:8px}').map((d) => d.name);
    expect(names).toEqual(['color', 'padding']);
  });

  it('bỏ qua thuộc tính không có giá trị', () => {
    expect(findDeclarations('a{color:;}')).toEqual([]);
  });

  it('không nhầm dấu hai chấm trong comment thành khai báo', () => {
    expect(findDeclarations('a{/* color: red */}')).toEqual([]);
  });

  it('không nhầm dấu hai chấm trong chuỗi thành khai báo', () => {
    const declarations = findDeclarations('a{content:"color: red"}');
    expect(declarations.map((declaration) => declaration.name)).toEqual(['content']);
    // The value is read from the original source, so the string survives.
    expect(declarations[0].value).toBe('"color: red"');
  });

  it('giữ được giá trị là chuỗi có nháy, để font-family không bị bỏ sót', () => {
    expect(findDeclarations('a{font-family:"Inter", sans-serif}')[0].value).toBe('"Inter", sans-serif');
  });

  it('giữ nguyên giá trị nhiều phần', () => {
    expect(findDeclarations('a{padding:8px 16px}')[0].value).toBe('8px 16px');
  });

  it('bỏ qua custom property khi lọc token', () => {
    expect(findTokenDeclarations('a{color:red;--x:1}').map((d) => d.name)).toEqual(['--x']);
  });
});

describe('findTokenReferences', () => {
  it('phát hiện tham chiếu và dấu dự phòng', () => {
    expect(findTokenReferences('a{color:var(--ink)}')).toEqual([{ name: '--ink', hasFallback: false, line: 1 }]);
    expect(findTokenReferences('a{color:var(--ink, red)}')).toEqual([{ name: '--ink', hasFallback: true, line: 1 }]);
  });

  it('bỏ qua tham chiếu nằm trong comment', () => {
    expect(findTokenReferences('/* var(--ink) */')).toEqual([]);
  });

  it('bỏ qua tham chiếu nằm trong chuỗi', () => {
    expect(findTokenReferences('a{content:"var(--ink)"}')).toEqual([]);
  });

  it('đếm đúng số dòng', () => {
    expect(findTokenReferences('a{\ncolor:var(--a)\n}')[0].line).toBe(2);
  });
});

describe('findColorLiterals', () => {
  it('nhận hex ba, sáu và tám ký tự', () => {
    expect(findColorLiterals('#fff #1a2b3c #11223344')).toEqual(['#fff', '#1a2b3c', '#11223344']);
  });

  it('nhận rgb, rgba, hsl, hsla', () => {
    expect(findColorLiterals('rgb(1,2,3) rgba(1,2,3,.5) hsl(1,2%,3%) hsla(1,2%,3%,.5)')).toHaveLength(4);
  });

  it('bỏ qua màu nằm trong var() để không báo hai lần', () => {
    expect(findColorLiterals('var(--ink, #000)')).toEqual([]);
  });

  it('bỏ qua từ khoá hợp lệ', () => {
    expect(findColorLiterals('transparent currentColor none')).toEqual([]);
  });

  it('không nhầm số hex trong tên class hoặc id', () => {
    expect(findColorLiterals('8px')).toEqual([]);
  });
});

describe('findSpacingLengths', () => {
  it('lấy mọi độ dài px trong giá trị shorthand', () => {
    expect(findSpacingLengths('8px 16px 8px 16px')).toEqual(['8px', '16px', '8px', '16px']);
  });

  it('bỏ qua giá trị bên trong calc và var', () => {
    expect(findSpacingLengths('calc(8px + 4px) var(--gap)')).toEqual([]);
  });

  it('bỏ qua rem, em và phần trăm', () => {
    expect(findSpacingLengths('1rem 2em 50%')).toEqual([]);
  });

  it('giữ lại giá trị 0px để lớp trên tự quyết định', () => {
    expect(findSpacingLengths('0px')).toEqual(['0px']);
  });

  it('nhận diện đúng thuộc tính khoảng cách', () => {
    for (const name of ['margin', 'padding', 'gap', 'padding-left', 'margin-block-start', 'row-gap']) {
      expect(isSpacingProperty(name), name).toBe(true);
    }
    for (const name of ['width', 'border-radius', 'margin-collapse', 'font-size']) {
      expect(isSpacingProperty(name), name).toBe(false);
    }
  });
});
