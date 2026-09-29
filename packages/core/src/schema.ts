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

export const prototypeTransitionSchema = z.object({
  fromScreenId: projectIdSchema,
  elementId: z.string().trim().min(1).max(200),
  toScreenId: projectIdSchema,
});

const prototypeFieldsSchema = z.object({
  id: projectIdSchema,
  name: z.string().trim().min(1).max(120),
  screenIds: z.array(projectIdSchema).min(2).max(50),
  startScreenId: projectIdSchema,
  transitions: z.array(prototypeTransitionSchema).max(5000),
});

const sourceBaselineSchema = z.record(projectIdSchema, z.string().regex(/^[a-f0-9]{64}$/));

function checkPrototypeLinks(value: { screenIds: string[]; startScreenId: string; transitions: { fromScreenId: string; elementId: string; toScreenId: string }[] }, context: z.RefinementCtx): void {
  const ids = new Set(value.screenIds);
  if (ids.size !== value.screenIds.length) context.addIssue({ code: 'custom', message: 'Màn hình prototype bị trùng.' });
  if (!ids.has(value.startScreenId)) context.addIssue({ code: 'custom', message: 'Màn hình bắt đầu không thuộc prototype.' });
  const links = new Set<string>();
  for (const transition of value.transitions) {
    if (!ids.has(transition.fromScreenId) || !ids.has(transition.toScreenId)) context.addIssue({ code: 'custom', message: 'Liên kết trỏ tới màn hình ngoài prototype.' });
    const key = `${transition.fromScreenId}\0${transition.elementId}`;
    if (links.has(key)) context.addIssue({ code: 'custom', message: 'Một phần tử chỉ được nối tới một màn hình.' });
    links.add(key);
  }
}

export const prototypeSchema = prototypeFieldsSchema.extend({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  sourceBaseline: sourceBaselineSchema,
}).superRefine((value, context) => {
  checkPrototypeLinks(value, context);
  if (Object.keys(value.sourceBaseline).length !== value.screenIds.length || value.screenIds.some((id) => !(id in value.sourceBaseline))) {
    context.addIssue({ code: 'custom', message: 'Dấu vân tay nguồn không khớp danh sách màn hình.' });
  }
});

export const prototypeCreateInputSchema = prototypeFieldsSchema.extend({ expectedSourceBaseline: sourceBaselineSchema }).superRefine((value, context) => {
  checkPrototypeLinks(value, context);
});
export const prototypePatchInputSchema = prototypeFieldsSchema.omit({ id: true }).partial().extend({ expectedRevision: z.number().int().nonnegative() });
export const prototypeRegenerateInputSchema = prototypeFieldsSchema.omit({ id: true, name: true }).extend({
  expectedRevision: z.number().int().nonnegative(),
  expectedSourceBaseline: sourceBaselineSchema,
}).superRefine((value, context) => checkPrototypeLinks(value, context));

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
  type: z.enum(['project.updated', 'screen.changed', 'project.error', 'screen.editing', 'prototype.updated']),
  message: z.string().optional(),
});

export type Screen = z.infer<typeof screenSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ScreenLayoutPatch = z.infer<typeof screenLayoutPatchSchema>;
export type ScreenOrder = z.infer<typeof screenOrderSchema>;
export type Prototype = z.infer<typeof prototypeSchema>;
export type PrototypeView = Prototype & { stale: boolean; changedScreenIds: string[]; missingScreenIds: string[] };
export type PrototypeCreateInput = z.infer<typeof prototypeCreateInputSchema>;
export type PrototypePatchInput = z.infer<typeof prototypePatchInputSchema>;
export type PrototypeRegenerateInput = z.infer<typeof prototypeRegenerateInputSchema>;
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
