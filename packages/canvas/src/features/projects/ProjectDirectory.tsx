import { useState } from 'react';
import type { Project } from '../../../../core/src/schema.js';
import { IconChevronRight, IconGrid, IconLayers, IconMonitor, IconPlus } from '../../icons.js';
import { CreateProjectDialog } from './CreateProjectDialog.js';

type Props = {
  projects: Project[];
  loading: boolean;
  error: string | null;
  connection: 'connected' | 'reconnecting';
  onChangePreview: () => void;
  onRetry: () => void;
  onCreate: (input: { id: string; name: string }) => Promise<Project>;
};

export function ProjectDirectory({ projects, loading, error, connection, onChangePreview, onRetry, onCreate }: Props) {
  const [creating, setCreating] = useState(false);
  return <main className="project-directory">
    <header className="project-directory-header">
      <span className="project-directory-brand"><IconGrid size={20} />Local Design Canvas</span>
      <div>
        <small className={`status-pill ${connection}`} data-testid="connection-status">{connection === 'connected' ? 'Đã kết nối' : 'Đang kết nối lại…'}</small>
        <button type="button" className="header-btn" onClick={onChangePreview}><IconMonitor size={14} />Đổi preview</button>
      </div>
    </header>
    <section className="project-directory-content" aria-labelledby="projects-title">
      <div className="project-directory-intro">
        <div>
        <span className="project-directory-eyebrow">KHÔNG GIAN LÀM VIỆC</span>
        <h1 id="projects-title">Dự án của bạn</h1>
        <p>Chọn một dự án để mở các màn hình và prototype của dự án đó.</p>
        </div>
        <button type="button" className="project-primary-btn" onClick={() => setCreating(true)}><IconPlus size={16} />Tạo dự án</button>
      </div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>Thử lại</button></div>}
      {loading ? <p role="status">Đang tải dự án…</p> : !error && projects.length === 0 ? <div className="project-directory-empty">
        <IconLayers size={32} />
        <h2>Chưa có dự án</h2>
        <p>Bấm Tạo dự án để bắt đầu, sau đó nhắn AI thiết kế các màn hình cho bạn.</p>
      </div> : <div className="project-directory-grid">
        {projects.map((project) => <a className="project-directory-card" key={project.id} href={`/?project=${encodeURIComponent(project.id)}`} aria-label={`Mở dự án ${project.name}`}>
          <div className="project-directory-card-top"><span className="project-directory-icon"><IconLayers size={24} /></span><span>{project.screens.length} màn hình</span></div>
          <h2>{project.name}</h2>
          <code>{project.id}</code>
          <span className="project-directory-card-open">Mở Canvas <IconChevronRight size={15} /></span>
        </a>)}
      </div>}
    </section>
    {creating && <CreateProjectDialog projects={projects} onCreate={onCreate} onClose={() => setCreating(false)} />}
  </main>;
}
