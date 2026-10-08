import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Project } from '../../../../core/src/schema.js';
import { ApiError } from '../../api.js';

type Props = {
  projects: Project[];
  onCreate: (input: { id: string; name: string }) => Promise<Project>;
  onClose: () => void;
};

function projectSlug(name: string): string {
  return name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').slice(0, 64).replace(/^-+|-+$/g, '') || 'project';
}

function availableId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  return id;
}

export function CreateProjectDialog({ projects, onCreate, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const used = new Set([...projects.map((project) => project.id), ...conflicts]);
  const id = availableId(projectSlug(name), used);

  useEffect(() => { dialog.current?.showModal(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    let candidate = id;
    try {
      // Only retry explicit ID conflicts: another client may create a project
      // after we loaded the directory. Other failures remain visible to retry.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const project = await onCreate({ id: candidate, name: name.trim() });
          window.location.assign(`/?project=${encodeURIComponent(project.id)}`);
          return;
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.code === 'PROJECT_EXISTS')) throw cause;
          const conflictedId = candidate;
          used.add(conflictedId);
          setConflicts((current) => [...current, conflictedId]);
          candidate = availableId(projectSlug(name), used);
        }
      }
      throw new Error('ID dự án vừa được sử dụng. Bạn hãy bấm Tạo dự án để thử lại.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tạo được dự án. Hãy thử lại.');
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return <dialog ref={dialog} className="create-project-dialog" aria-labelledby="create-project-title" onCancel={(event) => {
    event.preventDefault();
    if (!submittingRef.current) onClose();
  }}>
    <form onSubmit={(event) => void submit(event)} aria-busy={submitting}>
      <h2 id="create-project-title">Tạo dự án</h2>
      <p>Đặt tên cho không gian thiết kế mới của bạn.</p>
      <label htmlFor="new-project-name">Tên dự án</label>
      <input id="new-project-name" autoFocus required maxLength={200} placeholder="Ví dụ: Quản lý bán hàng" value={name} disabled={submitting} onChange={(event) => { setName(event.target.value); setError(null); }} aria-describedby="new-project-id" />
      <p id="new-project-id" className="create-project-id">ID tự động: <code>{name.trim() ? id : '—'}</code></p>
      {error && <p className="create-project-error" role="alert">{error}</p>}
      <div className="create-project-actions">
        <button type="button" className="header-btn" disabled={submitting} onClick={onClose}>Hủy</button>
        <button type="submit" className="project-primary-btn" disabled={submitting || !name.trim()}>{submitting ? 'Đang tạo…' : 'Tạo dự án'}</button>
      </div>
    </form>
  </dialog>;
}
