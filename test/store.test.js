import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readNdjson, readNdjsonDir, upsertNdjson, writeNdjson, writeJson, readJson,
  makeId, compressOld,
} from '../scripts/lib/store.js';

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wa-store-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readNdjson: 無いファイルは空配列', async () => {
  await withTmp(async (dir) => {
    assert.deepEqual(await readNdjson(join(dir, 'none.ndjson')), []);
  });
});

test('upsertNdjson: 同じ id を2回入れても増えない', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'a.ndjson');
    const recs = [{ id: 'x|1', v: 1 }, { id: 'x|2', v: 1 }];

    assert.deepEqual(await upsertNdjson(path, recs), { added: 2, updated: 0, skipped: 0, total: 2 });
    assert.deepEqual(await upsertNdjson(path, recs), { added: 0, updated: 0, skipped: 2, total: 2 });
    assert.equal((await readNdjson(path)).length, 2);
  });
});

test('upsertNdjson: 同一バッチ内の重複も落とす', async () => {
  await withTmp(async (dir) => {
    const r = await upsertNdjson(join(dir, 'b.ndjson'), [{ id: 'a' }, { id: 'a' }, { id: 'b' }]);
    assert.deepEqual(r, { added: 2, updated: 0, skipped: 1, total: 2 });
  });
});

test('upsertNdjson: replaceExisting で訂正を反映し、行数は増えない', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'r.ndjson');
    await upsertNdjson(path, [{ id: 'a', tmax: 30.1 }, { id: 'b', tmax: 28.0 }]);

    // 値が変わったものだけ updated になる
    const r = await upsertNdjson(
      path,
      [{ id: 'a', tmax: 30.4 }, { id: 'b', tmax: 28.0 }],
      { replaceExisting: true },
    );
    assert.deepEqual(r, { added: 0, updated: 1, skipped: 1, total: 2 });

    const rows = await readNdjson(path);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((x) => x.id === 'a').tmax, 30.4);
    // 並び順が保たれる
    assert.deepEqual(rows.map((x) => x.id), ['a', 'b']);
  });
});

test('upsertNdjson: id の無いレコードは投げる', async () => {
  await withTmp(async (dir) => {
    await assert.rejects(() => upsertNdjson(join(dir, 'c.ndjson'), [{ v: 1 }]), TypeError);
  });
});

test('readNdjson: 壊れた行を飛ばして残りを読む', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'd.ndjson');
    await writeNdjson(path, [{ id: 'a', v: 1 }]);
    await appendFile(path, '{"id":"b","v":\n', 'utf8'); // 途中で切れた行
    await appendFile(path, '{"id":"c","v":3}\n', 'utf8');
    const rows = await readNdjson(path);
    assert.deepEqual(rows.map((r) => r.id), ['a', 'c']);
  });
});

test('writeNdjson: 空配列なら空ファイル', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'e.ndjson');
    await writeNdjson(path, []);
    assert.equal(await readFile(path, 'utf8'), '');
  });
});

test('compressOld: gz 化しても透過的に読める', async () => {
  await withTmp(async (dir) => {
    await writeNdjson(join(dir, '2020.ndjson'), [{ id: 'old', v: 1 }]);
    await writeNdjson(join(dir, '2026.ndjson'), [{ id: 'new', v: 2 }]);

    assert.deepEqual(await compressOld(dir, 2026), ['2020.ndjson']);
    assert.deepEqual(await readNdjson(join(dir, '2020.ndjson')), [{ id: 'old', v: 1 }]);

    const all = await readNdjsonDir(dir);
    assert.deepEqual(all.map((r) => r.id).sort(), ['new', 'old']);
  });
});

test('writeJson / readJson', async () => {
  await withTmp(async (dir) => {
    const path = join(dir, 'x.json');
    assert.equal(await readJson(path, 'fb'), 'fb');
    await writeJson(path, { a: 1 });
    assert.deepEqual(await readJson(path), { a: 1 });
  });
});

test('makeId: 部品に | が入ったら投げる', () => {
  assert.equal(
    makeId('setagaya', 'ecmwf', '2026-09-12T12:00Z', '2026-09-15'),
    'setagaya|ecmwf|2026-09-12T12:00Z|2026-09-15',
  );
  assert.throws(() => makeId('a|b', 'c'), TypeError);
  assert.throws(() => makeId('a', null), TypeError);
});
