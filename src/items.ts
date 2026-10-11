import type { DatabaseSync } from 'node:sqlite';
import { latestReadings } from './balance.ts';
import { renderBoard, writeBoardFile } from './board.ts';
import type { Project } from './project.ts';

/** Regenera o `quadro.md` do projeto a partir do banco. */
export function refreshBoard(db: DatabaseSync, project: Project, now = new Date()): void {
  writeBoardFile(project.root, renderBoard(project.name, [], latestReadings(db), now));
}
