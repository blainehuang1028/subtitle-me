#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, ensureDir, parseCliArgs } from '../skills/subtitle-me/scripts/lib/common.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const EXACT_RUNTIME_FILES = new Set([
  'SKILL.md',
  'VERSION',
  'LICENSE',
  'agents/openai.yaml',
  'assets/icon-small.svg',
  'assets/logo-light.svg',
  'assets/logo-dark.svg',
]);

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Refusing to package non-regular file: ${child}`);
  }
  return files;
}

export async function collectRuntimeFiles(root = ROOT) {
  const skillRoot = join(root, 'skills', 'subtitle-me');
  const files = (await walk(skillRoot)).sort((a, b) => relative(skillRoot, a).localeCompare(relative(skillRoot, b), 'en'));
  const unexpected = files.map((path) => relative(skillRoot, path).replaceAll('\\', '/')).filter((path) => (
    !EXACT_RUNTIME_FILES.has(path)
    && !/^references\/[a-z0-9-]+\.md$/.test(path)
    && !/^scripts\/(?:lib\/)?[a-z0-9-]+\.mjs$/.test(path)
  ));
  if (unexpected.length > 0) throw new Error(`Refusing to package unexpected skill file(s): ${unexpected.join(', ')}`);
  if (files.length > MAX_FILES) throw new Error(`Refusing to package ${files.length} files; maximum is ${MAX_FILES}`);
  return files;
}

export function createStoreZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function addWorkBuddyFrontmatter(skillMarkdown, version) {
  const normalizedMarkdown = String(skillMarkdown).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const marker = '\n---\n';
  const closing = normalizedMarkdown.indexOf(marker, 4);
  if (!normalizedMarkdown.startsWith('---\n') || closing < 0) throw new Error('SKILL.md has no YAML frontmatter');
  const additions = [
    'description_zh: "将带时间轴的英文字幕翻译、审校并交付为简体中文字幕"',
    'description_en: "Translate and review timed English captions into Simplified Chinese"',
    `version: "${version}"`,
    'author: "Kai Huang"',
  ].join('\n');
  return `${normalizedMarkdown.slice(0, closing)}\n${additions}${normalizedMarkdown.slice(closing)}`;
}

export async function buildWorkBuddyPackage({ root = ROOT, outputPath } = {}) {
  const skillRoot = join(root, 'skills', 'subtitle-me');
  const version = (await readFile(join(skillRoot, 'VERSION'), 'utf8')).trim();
  const runtimeFiles = await collectRuntimeFiles(root);
  const prefix = 'skills/subtitle-me';
  const sizes = await Promise.all(runtimeFiles.map(async (path) => ({ path, bytes: (await stat(path)).size })));
  const oversizedPaths = sizes.filter((item) => item.bytes > MAX_FILE_BYTES);
  if (oversizedPaths.length > 0) throw new Error(`Refusing to package files over 5 MiB: ${oversizedPaths.map((item) => item.path).join(', ')}`);
  const sourceBytes = sizes.reduce((sum, item) => sum + item.bytes, 0);
  if (sourceBytes > MAX_TOTAL_BYTES) throw new Error(`Refusing to package ${(sourceBytes / 1024 / 1024).toFixed(1)} MiB; maximum is 20 MiB`);
  const fileEntries = await Promise.all(runtimeFiles.map(async (path) => {
    const relativePath = relative(skillRoot, path).replaceAll('\\', '/');
    const original = await readFile(path);
    const data = relativePath === 'SKILL.md'
      ? Buffer.from(addWorkBuddyFrontmatter(original.toString('utf8'), version), 'utf8')
      : original;
    return { name: `${prefix}/${relativePath}`, data };
  }));
  const oversized = fileEntries.filter((entry) => entry.data.length > MAX_FILE_BYTES);
  if (oversized.length > 0) throw new Error(`Refusing to package transformed files over 5 MiB: ${oversized.map((entry) => entry.name).join(', ')}`);
  const totalBytes = fileEntries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Refusing to package ${(totalBytes / 1024 / 1024).toFixed(1)} MiB; maximum is 20 MiB`);
  const entries = fileEntries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const zip = createStoreZip(entries);
  const requestedTarget = resolve(outputPath ?? join(root, 'dist', `subtitle-me-workbuddy-v${version}.zip`));
  const target = /\.zip$/i.test(requestedTarget) ? requestedTarget : `${requestedTarget}.zip`;
  await ensureDir(dirname(target));
  await atomicWrite(target, zip);
  return { outputPath: target, version, entries: entries.map((entry) => entry.name) };
}

async function main() {
  const { options } = parseCliArgs(process.argv.slice(2));
  const result = await buildWorkBuddyPackage({ outputPath: options.output ? String(options.output) : undefined });
  process.stdout.write(`WorkBuddy ZIP: ${result.outputPath}\nfiles: ${result.entries.length}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`package-workbuddy: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
