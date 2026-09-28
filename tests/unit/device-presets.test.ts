import { describe, expect, it } from 'vitest';
import { DEVICE_PRESETS, matchDevicePreset } from '../../packages/canvas/src/features/canvas/device-presets.js';

describe('device presets', () => {
  it('có Mobile, Tablet và Máy tính với chiều ngang hợp lệ', () => {
    expect(DEVICE_PRESETS.map((preset) => preset.id)).toEqual(['mobile', 'tablet', 'desktop']);
    for (const preset of DEVICE_PRESETS) {
      expect(preset.width).toBeGreaterThanOrEqual(240);
      expect(preset.width).toBeLessThanOrEqual(4096);
    }
  });

  it('khớp preset đang active theo chiều ngang hiện tại', () => {
    expect(matchDevicePreset(390)).toBe('mobile');
    expect(matchDevicePreset(768)).toBe('tablet');
    expect(matchDevicePreset(1280)).toBe('desktop');
    expect(matchDevicePreset(1000)).toBeNull();
  });
});
