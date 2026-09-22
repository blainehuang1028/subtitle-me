import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { addWorkBuddyFrontmatter, buildWorkBuddyPackage, collectRuntimeFiles } from '../scripts/package-workbuddy.mjs';

function readStoredEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(method, 0);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.set(name, buffer.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

test('builds a WorkBuddy ZIP with injected metadata and an allowlisted skill tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subtitle-me-package-'));
  const outputPath = join(directory, 'subtitle-me.zip');
  const result = await buildWorkBuddyPackage({ outputPath });
  const zip = await readFile(outputPath);
  const entries = readStoredEntries(zip);
  const skill = entries.get('skills/subtitle-me/SKILL.md').toString('utf8');
  assert.match(skill, /description_zh:/);
  assert.match(skill, /description_en:/);
  assert.match(skill, /version: "0\.2\.0"/);
  assert.match(skill, /author: "Kai Huang"/);
  assert.equal(entries.has('skills/subtitle-me/manifest.json'), false);
  assert.equal([...entries.keys()].every((name) => name.startsWith('skills/subtitle-me/')), true);
  assert.equal([...entries.keys()].some((name) => name.includes('/.git/')), false);
  assert.equal(result.entries.length > 5, true);
  assert.deepEqual([...entries.keys()].sort(), [...result.entries].sort());
});

test('normalizes CRLF frontmatter and appends .zip to extensionless output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subtitle-me-package-name-'));
  const transformed = addWorkBuddyFrontmatter('---\r\nname: subtitle-me\r\ndescription: Demo\r\n---\r\n\r\nBody\r\n', '0.1.0');
  assert.match(transformed, /^---\nname: subtitle-me\n/);
  const result = await buildWorkBuddyPackage({ outputPath: join(directory, 'bundle') });
  assert.equal(result.outputPath, join(directory, 'bundle.zip'));
  assert.equal((await readFile(result.outputPath)).length > 0, true);
});

test('refuses unexpected files instead of leaking them into the WorkBuddy ZIP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subtitle-me-package-allowlist-'));
  await cp(join(resolve('.'), 'skills', 'subtitle-me'), join(directory, 'skills', 'subtitle-me'), { recursive: true });
  await writeFile(join(directory, 'skills', 'subtitle-me', '.env'), 'UNEXPECTED=fixture\n', 'utf8');
  await assert.rejects(() => collectRuntimeFiles(directory), /unexpected skill file.*\.env/);
});
