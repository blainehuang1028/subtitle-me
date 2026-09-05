#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../skills/subtitle-me/scripts/lib/common.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runCli(cliPath, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`CLI failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

export async function runNeutralSmoke({ cliPath, root = ROOT } = {}) {
  const cli = resolve(cliPath ?? join(root, 'skills', 'subtitle-me', 'scripts', 'subtitle-me.mjs'));
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-smoke-'));
  const input = join(project, 'demo.en.srt');
  await copyFile(join(root, 'examples', 'demo', 'source.en.srt'), input);

  const initialized = runCli(cli, [
    'init', '--input', input, '--project', project, '--job', 'demo', '--ass', 'yes', '--title', 'yes',
  ]);
  const job = join(project, 'subtitle-localizer', 'jobs', 'demo');
  await copyFile(join(root, 'examples', 'demo', 'term-candidates.json'), join(job, 'qa', 'term-candidates.json'));
  await copyFile(join(root, 'examples', 'demo', 'term-decisions.json'), join(job, 'qa', 'term-decisions.json'));
  await copyFile(join(root, 'examples', 'demo', 'semantic.zh-Hans.srt'), join(job, 'subtitles', 'semantic.zh-Hans.srt'));

  runCli(cli, ['glossary', 'apply', '--job', job]);
  runCli(cli, ['readable', '--job', job]);
  runCli(cli, ['review', 'scaffold', '--job', job]);

  const reviewPath = join(job, 'qa', 'ai-review.json');
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  review.status = 'passed';
  review.reviewedAt = new Date().toISOString();
  review.coverage = [{ cueStart: 1, cueEnd: 20 }];
  review.notes = 'Independent fixture review completed for every cue.';
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  await writeFile(join(job, 'title.zh-Hans.md'), 'Original: Focus without noise\nChinese: 无干扰专注指南\n', 'utf8');

  runCli(cli, ['ass', 'build', '--job', job]);
  const qaOutput = runCli(cli, ['qa', '--job', job]);
  const qa = JSON.parse(await readFile(join(job, 'qa', 'qa.json'), 'utf8'));
  if (!qa.passed) throw new Error('Neutral smoke fixture did not pass QA');
  return { project, job, initialized, qaOutput, qa };
}

async function main() {
  const { options } = parseCliArgs(process.argv.slice(2));
  const selectedCli = resolve(options.cli ? String(options.cli) : join(ROOT, 'skills', 'subtitle-me', 'scripts', 'subtitle-me.mjs'));
  const result = await runNeutralSmoke({ cliPath: selectedCli });
  process.stdout.write(`CLI: ${basename(selectedCli)}\n`);
  process.stdout.write(`fixture: ${result.job}\nQA: PASS\nerrors: ${result.qa.errors.length}\nwarnings: ${result.qa.warnings.length}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`smoke-cli: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
