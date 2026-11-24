import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryCatalog, libraryFile } from './demo-library.js';

test('catalog lists supported regular files, hides paths and rejects path injection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'traffic-library-test-'));
  const previous = process.env.AI_LIBRARY_DIR; process.env.AI_LIBRARY_DIR = root;
  try {
    await mkdir(join(root, 'videos')); await mkdir(join(root, 'models')); await mkdir(join(root, 'policies'));
    await writeFile(join(root, 'videos', 'intersection.webm'), 'test');
    await writeFile(join(root, 'models', 'trained.pt'), 'test');
    await writeFile(join(root, 'models', 'ignore.txt'), 'test');
    await writeFile(join(root, 'policies', 'future.onnx'), 'test');
    await writeFile(join(root, 'videos', 'empty.mp4'), '');
    const catalog = await libraryCatalog();
    assert.equal(catalog.videos.length, 1); assert.equal(catalog.models.length, 1); assert.equal(catalog.policies.length, 1);
    assert.equal(catalog.models[0].name, 'trained.pt'); assert.equal('path' in catalog.models[0], false);
    assert.match(catalog.videos[0].streamPath!, /^\/api\/demo\/videos\/[a-f0-9]{24}\/stream$/);
    assert.equal((await libraryFile('models', catalog.models[0].id))?.path, await realpath(join(root, 'models', 'trained.pt')));
    for (const id of ['../trained.pt', '/private.pt', 'https://evil.test', 'a'.repeat(24), null]) assert.equal(await libraryFile('models', id), undefined);
    await rm(join(root, 'videos', 'intersection.webm'));
    assert.equal((await libraryCatalog()).videos.length, 0);
  } finally {
    if (previous === undefined) delete process.env.AI_LIBRARY_DIR; else process.env.AI_LIBRARY_DIR = previous;
    // Only the uniquely named temporary test directory created above is removed.
    await rm(root, { recursive: true, force: true });
  }
});
