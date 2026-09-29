import { describe, expect, it } from 'vitest';
import { prototypeSchema } from '../../packages/core/src/schema.js';

const valid = {
  schemaVersion: 1,
  revision: 0,
  id: 'movie-booking',
  name: 'Đặt vé',
  screenIds: ['home', 'movie-detail'],
  startScreenId: 'home',
  sourceBaseline: { home: 'a'.repeat(64), 'movie-detail': 'b'.repeat(64) },
  transitions: [{ fromScreenId: 'home', elementId: 'home-el-12', toScreenId: 'movie-detail' }],
};

describe('prototype schema', () => {
  it('accepts a stable slug ID and screen-based transition', () => {
    expect(prototypeSchema.parse(valid).id).toBe('movie-booking');
  });

  it('rejects duplicate hotspots from the same screen', () => {
    expect(prototypeSchema.safeParse({ ...valid, transitions: [...valid.transitions, { ...valid.transitions[0] }] }).success).toBe(false);
  });

  it('rejects duplicate screens and transitions outside the screen set', () => {
    expect(prototypeSchema.safeParse({ ...valid, screenIds: ['home', 'home'] }).success).toBe(false);
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'x', toScreenId: 'checkout' }] }).success).toBe(false);
  });
});
