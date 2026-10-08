// Undo/redo for canvas layout gestures.
//
// A gesture — one drag, one resize, one typed width — is the unit of undo, not a
// single pointer move, so undoing a drag returns the frame to where it started
// rather than stepping back through every intermediate position.
//
// Entries are opaque: the caller records two closures that restore the before and
// the after state. That keeps the stack free of layout knowledge and lets a screen
// move and a prototype move share one history.
export type HistoryEntry = {
  // Restores the state the gesture started from.
  undo: () => void;
  // Restores the state the gesture left behind.
  redo: () => void;
};

// A long working session would otherwise grow this without bound. Fifty gestures
// is far more than anyone walks back, and each entry holds only a few numbers.
const HISTORY_LIMIT = 50;

export class LayoutHistory {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  // Recording a fresh gesture abandons the redo branch: the timeline the user
  // could have moved forward into no longer exists.
  record(entry: HistoryEntry): void {
    this.past.push(entry);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  undo(): boolean {
    const entry = this.past.pop();
    if (!entry) return false;
    entry.undo();
    this.future.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.future.pop();
    if (!entry) return false;
    entry.redo();
    this.past.push(entry);
    return true;
  }

  // Entries name screens by id, so they cannot survive a project switch or a
  // delete. Both callers drop the whole history instead of pruning it.
  clear(): void {
    this.past = [];
    this.future = [];
  }
}
