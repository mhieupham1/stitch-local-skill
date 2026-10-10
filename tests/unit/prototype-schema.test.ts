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

  it('defaults a transition with no kind to push', () => {
    expect(prototypeSchema.parse(valid).transitions[0].kind).toBe('push');
  });

  it('accepts overlay with a screen target and back with none', () => {
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'overlay', toScreenId: 'movie-detail' }] }).success).toBe(true);
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'back' }] }).success).toBe(true);
  });

  it('accepts scroll only with an in-screen target', () => {
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'scroll', toElementId: 'home-el-3' }] }).success).toBe(true);
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'scroll' }] }).success).toBe(false);
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'scroll', toElementId: 'home-el-3', toScreenId: 'movie-detail' }] }).success).toBe(false);
  });

  it('rejects a target on back and a missing target on push/overlay', () => {
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'back', toScreenId: 'movie-detail' }] }).success).toBe(false);
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'push' }] }).success).toBe(false);
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'overlay' }] }).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(prototypeSchema.safeParse({ ...valid, transitions: [{ fromScreenId: 'home', elementId: 'a', kind: 'fade', toScreenId: 'movie-detail' }] }).success).toBe(false);
  });
});
