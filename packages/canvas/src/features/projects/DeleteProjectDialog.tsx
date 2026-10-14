import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../../core/src/schema.js';
import { ApiError } from '../../api.js';

export type ProjectDeletion = {
  projectId: string;
  name: string;
  screens: string[];
  snapshots: number;
  prototypes: number;
  deleted: boolean;
};

type Props = {
  project: Project;
  /** Reads what the deletion would remove. Must not change anything. */
  onPreview: (project: Project) => Promise<ProjectDeletion>;
  onDelete: (project: Project) => Promise<void>;
  onClose: () => void;
};

/**
 * Deletion is permanent — there is no trash and no undo — so the dialog first
 * asks the server what would go, then names each part in the confirmation
 * sentence. The user reads "5 màn hình, 2 snapshot, 1 prototype" rather than
 * agreeing to a generic warning.
 */
export function DeleteProjectDialog({ project, onPreview, onDelete, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [summary, setSummary] = useState<ProjectDeletion | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => { dialog.current?.showModal(); }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await onPreview(project);
        if (!cancelled) setSummary(result);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Không đọc được nội dung dự án.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [onPreview, project]);

  // Typing the project name is the guard: it is the one word the user has to
  // read to get past this, which a single click on "Xoá" never forces.
  const confirmed = typed.trim() === project.name;

  const submit = async () => {
    if (!confirmed || busyRef.current) return;
    busyRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(project);
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Không xoá được dự án. Hãy thử lại.');
      busyRef.current = false;
      setSubmitting(false);
    }
  };

  const parts: string[] = [];
  if (summary) {
    parts.push(`${summary.screens.length} màn hình`);
    if (summary.snapshots > 0) parts.push(`${summary.snapshots} snapshot`);
    if (summary.prototypes > 0) parts.push(`${summary.prototypes} prototype`);
  }

  return <dialog ref={dialog} className="create-project-dialog" aria-labelledby="delete-project-title" onCancel={(event) => {
    event.preventDefault();
    if (!busyRef.current) onClose();
  }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={submitting}>
      <h2 id="delete-project-title">Xoá dự án</h2>
      <p>
        Thao tác này không hoàn tác được và không có thùng rác.
        {loading
          ? ' Đang đọc nội dung dự án…'
          : summary && <> Sẽ xoá vĩnh viễn <strong>{parts.join(', ')}</strong> của dự án.</>}
      </p>
      <label htmlFor="delete-project-confirm">Nhập <code>{project.name}</code> để xác nhận</label>
      <input
        id="delete-project-confirm"
        autoFocus
        autoComplete="off"
        value={typed}
        disabled={submitting || loading}
        onChange={(event) => { setTyped(event.target.value); setError(null); }}
      />
      {error && <p className="create-project-error" role="alert">{error}</p>}
      <div className="create-project-actions">
        <button type="button" className="header-btn" disabled={submitting} onClick={onClose}>Hủy</button>
        <button type="submit" className="project-danger-btn" disabled={submitting || loading || !confirmed}>
          {submitting ? 'Đang xoá…' : 'Xoá dự án'}
        </button>
      </div>
    </form>
  </dialog>;
}
