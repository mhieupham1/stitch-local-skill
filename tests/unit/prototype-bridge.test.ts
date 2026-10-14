import { describe, expect, it } from 'vitest';
import { prototypeBridgeScriptSource } from '../../packages/preview-bridge/src/index.js';

describe('prototype preview bridge', () => {
  it('serializes configuration safely and handles nested hotspots without running source handlers', () => {
    const script = prototypeBridgeScriptSource({ projectId: 'shop', screenId: 'home', nonce: '</script><script>alert(1)</script>', parentOrigin: 'http://127.0.0.1:1234' });
    expect(script).not.toContain('</script><script>alert(1)</script>');
    expect(script).toContain('prototype.ready');
    expect(script).toContain('prototype.initialized');
    expect(script).toContain('prototype.click');
    expect(script).toContain('stopImmediatePropagation');
    expect(script).toContain('parentElement');
  });

  it('handles the scroll and escape messages the player sends', () => {
    const script = prototypeBridgeScriptSource({ projectId: 'shop', screenId: 'home', nonce: 'n', parentOrigin: 'http://127.0.0.1:1234' });
    expect(script).toContain('prototype.scroll');
    expect(script).toContain('prototype.scrolled');
    expect(script).toContain('scrollIntoView');
    expect(script).toContain('prototype.escape');
  });
});
