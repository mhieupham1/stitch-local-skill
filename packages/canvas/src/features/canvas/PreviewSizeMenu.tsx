import { DEVICE_PRESETS, matchDevicePreset } from './device-presets.js';

type Props = {
  width: number;
  disabled?: boolean;
  onPick: (width: number) => void;
};

/**
 * Header preview-size controls for the selected screen. Picking a preset only
 * changes the frame width so CSS breakpoints inside the preview update.
 */
export function PreviewSizeMenu({ width, disabled, onPick }: Props) {
  const active = matchDevicePreset(width);
  return (
    <select
      className="preview-size-menu"
      id="preview-size-menu"
      aria-label="Kích thước xem trước"
      data-testid="preview-size-menu"
      value={active ? String(width) : ''}
      disabled={disabled}
      onChange={(event) => onPick(Number(event.target.value))}
    >
      {!active && <option value="" disabled>Tuỳ chỉnh · {width}px</option>}
      {DEVICE_PRESETS.map((preset) => (
        <option key={preset.id} value={preset.width}>{preset.label} · {preset.width}px</option>
      ))}
    </select>
  );
}
