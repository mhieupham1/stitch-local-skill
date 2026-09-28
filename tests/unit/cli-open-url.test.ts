import { describe, expect, it } from 'vitest';
import { canvasOpenUrl } from '../../packages/cli/src/index.js';

describe('canvasOpenUrl', () => {
  it('đưa preview URL vào fragment và giữ nguyên địa chỉ gốc', () => {
    const url = new URL(canvasOpenUrl(
      { instanceId: 'instance', pid: 1, url: 'http://127.0.0.1:3456', previewUrl: 'http://127.0.0.1:4567' },
    ));
    expect(url.search).toBe('');
    expect(url.hash).toContain('previewUrl=http%3A%2F%2F127.0.0.1%3A4567');
    // No credential is handed to the browser: the canvas is reachable directly.
    expect(url.hash).not.toContain('token');
  });
});
