export type DevicePreset = {
  id: 'mobile' | 'tablet' | 'desktop';
  label: string;
  width: number;
};

/** Common preview widths. Only width changes; height stays the design height. */
export const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'mobile', label: 'Mobile', width: 390 },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'desktop', label: 'Máy tính', width: 1280 },
];

export function matchDevicePreset(width: number): DevicePreset['id'] | null {
  return DEVICE_PRESETS.find((preset) => preset.width === width)?.id ?? null;
}
