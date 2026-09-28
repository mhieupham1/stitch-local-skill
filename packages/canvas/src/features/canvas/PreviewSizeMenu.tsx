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
    <div className="preview-size-menu" id="preview-size-menu" role="group" aria-label="Kích thước xem trước" data-testid="preview-size-menu">
      {DEVICE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className={active === preset.id ? 'active' : ''}
          aria-pressed={active === preset.id}
          disabled={disabled}
          onClick={() => onPick(preset.width)}
        >
          {preset.label}
          <small>{preset.width}</small>
        </button>
      ))}
    </div>
  );
}
