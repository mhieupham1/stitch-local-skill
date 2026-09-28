import { z } from 'zod';

export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const projectIdSchema = z
  .string()
  .regex(ID_PATTERN, 'ID phải là slug ASCII chữ thường, số và dấu gạch ngang.');

export const screenSchema = z.object({
  id: projectIdSchema,
  name: z.string().trim().min(1),
  entry: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().int().min(240).max(4096),
  height: z.number().int().min(240).max(4096),
});

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  id: projectIdSchema,
  name: z.string().trim().min(1),
  screens: z.array(screenSchema),
});

export const screenLayoutPatchSchema = z.object({
  id: projectIdSchema,
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().int().min(240).max(4096).optional(),
  height: z.number().int().min(240).max(4096).optional(),
});

// A layer order must list every screen in the project exactly once. Shipping it
// as a whole list (instead of a per-screen index) means two clients reordering at
// the same time cannot silently collapse two screens onto the same layer.
export const screenOrderSchema = z.array(projectIdSchema);

export const selectionBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

export const selectionContextSchema = z.object({
  projectId: projectIdSchema,
  screenId: projectIdSchema,
  // The server computes the authoritative source hash on record, so an incoming
  // context may carry an empty string here; `get` always returns a non-empty value.
  sourceRevision: z.string(),
  elementId: z.string().min(1).nullable(),
  selector: z.string().min(1),
  text: z.string(),
  bounds: selectionBoundsSchema,
});

export const canvasEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  instanceId: z.string().min(1),
  projectId: projectIdSchema,
  screenIds: z.array(projectIdSchema),
  type: z.enum(['project.updated', 'screen.changed', 'project.error', 'screen.editing']),
  message: z.string().optional(),
});

export type Screen = z.infer<typeof screenSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ScreenLayoutPatch = z.infer<typeof screenLayoutPatchSchema>;
export type ScreenOrder = z.infer<typeof screenOrderSchema>;
export type CanvasEvent = z.infer<typeof canvasEventSchema>;
export type SelectionBounds = z.infer<typeof selectionBoundsSchema>;
export type SelectionContext = z.infer<typeof selectionContextSchema>;

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export class CanvasError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function asCanvasError(error: unknown, fallbackCode = 'INTERNAL_ERROR'): CanvasError {
  if (error instanceof CanvasError) return error;
  if (error instanceof z.ZodError) {
    return new CanvasError('VALIDATION_ERROR', error.issues.map((issue) => issue.message).join('; '));
  }
  return new CanvasError(fallbackCode, error instanceof Error ? error.message : 'Lỗi không xác định.', 500);
}
