import { readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LibraryKind = 'videos' | 'models' | 'policies';
export type LibraryEntry = { id: string; name: string; size: number; streamPath?: string };
const formats = { videos: ['.mp4', '.webm'], models: ['.pt'], policies: ['.pt', '.pth', '.onnx', '.zip'] };
export const libraryRoot = () => resolve(process.env.AI_LIBRARY_DIR || fileURLToPath(new URL('../demo-library/', import.meta.url)));
const inside = (root: string, target: string) => { const path = relative(root, target); return path !== '' && !path.startsWith('..') && !isAbsolute(path); };
export async function libraryEntries(kind: LibraryKind): Promise<(LibraryEntry & { path: string })[]> {
  const root = libraryRoot(), directory = resolve(root, kind);
  let files;
  try { files = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const entries = await Promise.all(files.filter(file => file.isFile() && formats[kind].includes(extname(file.name).toLowerCase())).map(async file => {
    const path = await realpath(resolve(directory, file.name));
    // Never follow a library symlink outside its kind directory.
    if (!inside(directory, path) || !inside(root, await realpath(directory))) return null;
    const details = await stat(path);
    const limit = kind === 'videos' ? 2 * 1024 ** 3 : 100 * 1024 ** 2;
    if (!details.isFile() || details.size === 0 || details.size > limit) return null;
    const id = createHash('sha256').update(kind + '/' + file.name).digest('hex').slice(0, 24);
    return { id, name: file.name, size: details.size, path, ...(kind === 'videos' ? { streamPath: `/api/demo/videos/${id}/stream` } : {}) };
  }));
  return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((a, b) => a.name.localeCompare(b.name));
}
export async function libraryFile(kind: LibraryKind, id: unknown) {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) return undefined;
  return (await libraryEntries(kind)).find(entry => entry.id === id);
}
export async function libraryCatalog() {
  const lists = await Promise.all((['videos', 'models', 'policies'] as const).map(libraryEntries));
  const clean = (entries: (LibraryEntry & { path: string })[]) => entries.map(({ path: _path, ...entry }) => entry);
  return { videos: clean(lists[0]), models: clean(lists[1]), policies: clean(lists[2]) };
}
