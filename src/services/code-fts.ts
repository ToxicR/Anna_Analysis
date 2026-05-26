import { db } from "../db.js";
import type { CodeChunk } from "../types.js";

const FTS_TABLE = "code_chunks_fts";

export function initCodeFts(): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      file_path,
      content,
      chunk_id UNINDEXED,
      repo_id UNINDEXED,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  rebuildFtsIndexIfEmpty();
}

export function clearRepoFts(repoId: number): void {
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE repo_id = ?`).run(repoId);
}

export function indexChunkFts(chunkId: number, repoId: number, filePath: string, content: string): void {
  db.prepare(`
    INSERT INTO ${FTS_TABLE}(file_path, content, chunk_id, repo_id)
    VALUES (?, ?, ?, ?)
  `).run(filePath, content, chunkId, repoId);
}

export function rebuildFtsIndex(): number {
  db.exec(`DELETE FROM ${FTS_TABLE}`);
  const result = db.prepare(`
    INSERT INTO ${FTS_TABLE}(file_path, content, chunk_id, repo_id)
    SELECT file_path, content, id, repo_id FROM code_chunks
  `).run();
  return result.changes;
}

function rebuildFtsIndexIfEmpty(): void {
  const ftsCount = db.prepare(`SELECT COUNT(*) AS count FROM ${FTS_TABLE}`).get() as { count: number };
  const chunkCount = db.prepare("SELECT COUNT(*) AS count FROM code_chunks").get() as { count: number };
  if (chunkCount.count > 0 && ftsCount.count === 0) {
    rebuildFtsIndex();
  }
}

export function buildFtsQuery(terms: string[]): string | null {
  const parts = terms
    .map((term) => term.replace(/"/g, '""').trim())
    .filter((term) => term.length >= 2)
    .map((term) => {
      if (/^[\u4e00-\u9fa5]+$/.test(term)) return `"${term}"`;
      if (/^[a-z0-9_.$/ -]+$/i.test(term)) return `"${term}"*`;
      return `"${term}"`;
    });
  if (!parts.length) return null;
  return parts.join(" OR ");
}

export function searchCodeFts(repoIds: number[], terms: string[], limit: number): CodeChunk[] | null {
  const ftsQuery = buildFtsQuery(terms);
  if (!ftsQuery || !repoIds.length) return null;

  const placeholders = repoIds.map(() => "?").join(",");
  try {
    return db.prepare(`
      SELECT c.*
      FROM ${FTS_TABLE} AS f
      JOIN code_chunks AS c ON c.id = f.chunk_id
      WHERE f.repo_id IN (${placeholders})
        AND f MATCH ?
      ORDER BY bm25(f)
      LIMIT ?
    `).all(...repoIds, ftsQuery, limit) as CodeChunk[];
  } catch {
    return null;
  }
}
