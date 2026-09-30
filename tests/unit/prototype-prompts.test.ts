import { describe, expect, it } from 'vitest';
import { createPrototypePrompt, regeneratePrototypePrompt } from '../../packages/canvas/src/features/prototypes/prompts.js';

describe('Canvas prototype prompts', () => {
  it('names the exact project and selected screens without inventing navigation', () => {
    const prompt = createPrototypePrompt('cgv-home', ['home', 'movie-detail', 'seat-map']);
    expect(prompt).toContain('local-design-canvas');
    expect(prompt).toContain('projectId: cgv-home');
    expect(prompt).toContain('home, movie-detail, seat-map');
    expect(prompt).toContain('data-design-id');
    expect(prompt).toContain('prototype create');
    expect(prompt).not.toContain('home -> movie-detail');
  });

  it('preserves the project/prototype pair and requests explicit regeneration', () => {
    const prompt = regeneratePrototypePrompt('cgv-home', 'booking-v2', ['home', 'movie-detail']);
    expect(prompt).toContain('projectId: cgv-home');
    expect(prompt).toContain('prototypeId: booking-v2');
    expect(prompt).toContain('prototype regenerate');
    expect(prompt).toContain('home, movie-detail');
  });
});
