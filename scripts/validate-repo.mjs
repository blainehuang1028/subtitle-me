#!/usr/bin/env node

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkBuddyPackage } from './package-workbuddy.mjs';
import { pathExists, readJson, readUtf8, UserError } from '../skills/subtitle-me/scripts/lib/common.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = [
  'skills/subtitle-me/SKILL.md',
  'skills/subtitle-me/agents/openai.yaml',
  'skills/subtitle-me/assets/icon-small.svg',
  'skills/subtitle-me/assets/logo-light.svg',
  'skills/subtitle-me/assets/logo-dark.svg',
  'docs/images/social-preview.svg',
  'docs/images/social-preview.png',
  'skills/subtitle-me/scripts/subtitle-me.mjs',
  'skills/subtitle-me/references/workflow.md',
  'skills/subtitle-me/references/terminology.md',
  'skills/subtitle-me/references/translation-review.md',
  'skills/subtitle-me/references/formats-layout.md',
  'skills/subtitle-me/references/ass-preview.md',
  'examples/demo/source.en.srt',
  'examples/demo/semantic.zh-Hans.srt',
  'LICENSE',
  'skills/subtitle-me/VERSION',
  'package.json',
];

async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['.git', '.qa', '.playwright-cli', 'dist', 'node_modules'].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await walk(child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

async function main() {
  const errors = [];
  for (const item of REQUIRED) if (!(await pathExists(join(ROOT, item)))) errors.push(`missing ${item}`);
  const version = (await readUtf8(join(ROOT, 'skills', 'subtitle-me', 'VERSION'))).trim();
  const packageJson = await readJson(join(ROOT, 'package.json'));
  if (packageJson.version !== version) errors.push('package.json version does not match VERSION');
  const skill = (await readUtf8(join(ROOT, 'skills', 'subtitle-me', 'SKILL.md'))).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const skillRoot = join(ROOT, 'skills', 'subtitle-me');
  if (!skill.startsWith('---\nname: subtitle-me\n')) errors.push('SKILL.md frontmatter is malformed');
  if (/^(description_zh|description_en|version|author):/m.test(skill.split('\n---\n', 1)[0])) {
    errors.push('WorkBuddy-only fields leaked into standard SKILL.md');
  }
  const linkedReferences = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((match) => match[1]);
  for (const reference of linkedReferences) if (!(await pathExists(join(skillRoot, reference)))) errors.push(`broken reference ${reference}`);

  const textFiles = (await walk(ROOT)).filter((path) => /\.(?:md|mjs|json|ya?ml|srt|svg)$/.test(path));
  const unfinishedPattern = new RegExp(`\\[(?:${['TO', 'DO'].join('')}|${['T', 'BD'].join('')})|${['TO', 'DO'].join('')}:|Briefly ${'describe'}|Add the task-specific ${'guidance'}`, 'i');
  const excludedPattern = new RegExp([['mara', 'thon'].join(''), ['u', 'esc'].join(''), ['bili', 'bili'].join('')].join('|'), 'i');
  for (const path of textFiles) {
    const content = await readUtf8(path);
    const name = relative(ROOT, path).replaceAll('\\', '/');
    if (unfinishedPattern.test(content)) errors.push(`${name} contains unfinished placeholder text`);
    if (/\/Users\/|[A-Z]:\\Users\\/.test(content)) errors.push(`${name} contains a machine-specific absolute path`);
    if ((name.startsWith('skills/') || name.startsWith('examples/demo/')) && excludedPattern.test(content)) errors.push(`${name} contains excluded project-specific material`);
  }

  const packageDir = await mkdtemp(join(tmpdir(), 'subtitle-me-validate-'));
  const built = await buildWorkBuddyPackage({ root: ROOT, outputPath: join(packageDir, 'subtitle-me.zip') });
  if (!built.entries.includes('skills/subtitle-me/SKILL.md')) errors.push('WorkBuddy package is missing SKILL.md');
  if (errors.length > 0) throw new UserError(`Repository validation failed:\n- ${errors.join('\n- ')}`);
  process.stdout.write(`repository: valid\nversion: ${version}\nreferences: ${linkedReferences.length}\nworkbuddy files: ${built.entries.length}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
