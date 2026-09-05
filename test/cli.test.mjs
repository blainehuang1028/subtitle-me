import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runNeutralSmoke } from '../scripts/smoke-cli.mjs';
import { parseSrt, writeSrt } from '../skills/subtitle-me/scripts/lib/subtitles.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'skills', 'subtitle-me', 'scripts', 'subtitle-me.mjs');

test('runs the public CLI through init, terminology, review, ASS, title, and final QA', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  assert.match(result.initialized, /source cues: 20/);
  assert.match(result.qaOutput, /QA: PASS/);
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8')).passed, true);
  assert.match(invoke(['status', '--job', result.job]).stdout, /qa: passed/);
  const semanticPath = join(result.job, 'subtitles', 'semantic.zh-Hans.srt');
  const semantic = await readFile(semanticPath, 'utf8');
  await writeFile(semanticPath, 'malformed subtitle\n', 'utf8');
  const failedQa = invoke(['qa', '--job', result.job]);
  assert.notEqual(failedQa.status, 0);
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8')).status, 'pending');
  assert.match(await readFile(join(result.job, 'report.md'), 'utf8'), /Status: PENDING/);
  assert.match(invoke(['status', '--job', result.job]).stdout, /qa: pending/);
  await writeFile(semanticPath, semantic, 'utf8');
  const regenerated = invoke(['readable', '--job', result.job]);
  assert.equal(regenerated.status, 0, regenerated.stderr);
  const invalidatedReview = JSON.parse(await readFile(join(result.job, 'qa', 'ai-review.json'), 'utf8'));
  assert.equal(invalidatedReview.status, 'pending');
  assert.equal(invalidatedReview.previousReview.status, 'passed');
  const invalidatedQa = JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8'));
  assert.equal(invalidatedQa.status, 'pending');
  assert.equal(invalidatedQa.passed, false);
  assert.match(await readFile(join(result.job, 'report.md'), 'utf8'), /Status: PENDING/);
  assert.match(invoke(['status', '--job', result.job]).stdout, /aiReview: pending/);
});

test('invalidates passed QA before a readable regeneration can fail', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  const semanticPath = join(result.job, 'subtitles', 'semantic.zh-Hans.srt');
  const semantic = parseSrt(await readFile(semanticPath, 'utf8'));
  semantic[0].text = '这是一个没有安全断点的超长字幕'.repeat(10);
  await writeFile(semanticPath, writeSrt(semantic), 'utf8');

  const failed = invoke(['readable', '--job', result.job]);
  assert.notEqual(failed.status, 0);
  const job = JSON.parse(await readFile(join(result.job, 'job.json'), 'utf8'));
  assert.equal(job.phases.readable.status, 'pending');
  assert.equal(job.phases.aiReview.status, 'pending');
  assert.equal(job.phases.ass.status, 'pending');
  assert.equal(job.phases.qa.status, 'pending');
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8')).status, 'pending');
  assert.match(await readFile(join(result.job, 'report.md'), 'utf8'), /Status: PENDING/);
});

test('invalidates passed QA before an ASS rebuild can fail', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  await writeFile(join(result.job, 'subtitles', 'readable.en.srt'), 'malformed subtitle\n', 'utf8');

  const failed = invoke(['ass', 'build', '--job', result.job]);
  assert.notEqual(failed.status, 0);
  const job = JSON.parse(await readFile(join(result.job, 'job.json'), 'utf8'));
  assert.equal(job.phases.ass.status, 'pending');
  assert.equal(job.phases.qa.status, 'pending');
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8')).status, 'pending');
  assert.match(await readFile(join(result.job, 'report.md'), 'utf8'), /Status: PENDING/);
});

test('invalidates passed review and QA before review scaffolding can fail', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  await unlink(join(result.job, 'subtitles', 'semantic.zh-Hans.srt'));

  const failed = invoke(['review', 'scaffold', '--job', result.job]);
  assert.notEqual(failed.status, 0);
  const job = JSON.parse(await readFile(join(result.job, 'job.json'), 'utf8'));
  assert.equal(job.phases.aiReview.status, 'pending');
  assert.equal(job.phases.qa.status, 'pending');
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'ai-review.json'), 'utf8')).status, 'pending');
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8')).status, 'pending');
  assert.match(await readFile(join(result.job, 'report.md'), 'utf8'), /Status: PENDING/);
});

test('review scaffolding recovers from a malformed prior review file', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  await writeFile(join(result.job, 'qa', 'ai-review.json'), '{ malformed', 'utf8');

  const recovered = invoke(['review', 'scaffold', '--job', result.job]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const review = JSON.parse(await readFile(join(result.job, 'qa', 'ai-review.json'), 'utf8'));
  assert.equal(review.status, 'pending');
  assert.equal(review.coverage.length, 0);
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8')).status, 'pending');
});

test('review scaffolding invalidates QA before recovering unreadable review bytes', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  await writeFile(join(result.job, 'qa', 'ai-review.json'), Buffer.from([0xFF, 0xFE, 0x61]));

  const recovered = invoke(['review', 'scaffold', '--job', result.job]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'ai-review.json'), 'utf8')).status, 'pending');
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8')).status, 'pending');
  assert.match(await readFile(join(result.job, 'report.md'), 'utf8'), /Status: PENDING/);
});

test('source refresh invalidates old PASS before malformed terminology can abort it', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  const jobBefore = JSON.parse(await readFile(join(result.job, 'job.json'), 'utf8'));
  await writeFile(join(result.job, 'qa', 'term-candidates.json'), '{ malformed', 'utf8');
  await writeFile(jobBefore.source.originalPath, '1\n00:00:00,000 --> 00:00:02,000\nChanged source.\n', 'utf8');

  const failed = invoke([
    'init', '--input', jobBefore.source.originalPath, '--project', result.project, '--job', jobBefore.id,
    '--ass', 'yes', '--title', 'yes',
  ]);
  assert.notEqual(failed.status, 0);
  const jobAfter = JSON.parse(await readFile(join(result.job, 'job.json'), 'utf8'));
  assert.equal(jobAfter.phases.normalized.status, 'refreshing');
  assert.equal(jobAfter.phases.qa.status, 'pending');
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'ai-review.json'), 'utf8')).status, 'pending');
  assert.equal(JSON.parse(await readFile(join(result.job, 'qa', 'qa.json'), 'utf8')).status, 'pending');
  assert.match(await readFile(join(result.job, 'report.md'), 'utf8'), /Status: PENDING/);
});

test('keeps a passed job intact when glossary --only validation fails', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  const tracked = [
    join(result.job, 'job.json'),
    join(result.job, 'qa', 'qa.json'),
    join(result.job, 'qa', 'ai-review.json'),
    join(result.job, 'report.md'),
  ];
  const before = await Promise.all(tracked.map((path) => readFile(path, 'utf8')));
  const failed = invoke(['glossary', 'apply', '--job', result.job, '--only', 'does-not-exist']);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Unknown --only selection/);
  const after = await Promise.all(tracked.map((path) => readFile(path, 'utf8')));
  assert.deepEqual(after, before);
});

function invoke(args, cwd = ROOT) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

test('rejects misspelled, duplicate, and missing-value options', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-cli-options-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:01,000\nHello.\n', 'utf8');
  assert.match(invoke(['init', '--input', input, '--project', project, '--titel']).stderr, /Unknown option --titel/);
  assert.match(invoke(['init', '--input', input, '--project']).stderr, /Missing value for --project/);
  assert.match(invoke(['init', '--input', input, '--input', input]).stderr, /provided more than once/);
});

test('refuses to create mutable project state inside the installed skill', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-cli-root-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:01,000\nHello.\n', 'utf8');
  const result = invoke(['init', '--input', input], join(ROOT, 'skills', 'subtitle-me'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the installed subtitle-me skill/);
});

test('rejects symbolic links anywhere in project state', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subtitle-me-cli-symlink-'));
  const project = join(root, 'project');
  const victim = join(root, 'victim');
  await mkdir(project);
  await mkdir(victim);
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:01,000\nHello.\n', 'utf8');
  await symlink(victim, join(project, 'subtitle-localizer'), 'dir');

  const redirectedInit = invoke(['init', '--input', input, '--project', project]);
  assert.notEqual(redirectedInit.status, 0);
  assert.match(redirectedInit.stderr, /Symbolic links are not allowed/);
  await assert.rejects(access(join(victim, 'glossary.json')));

  await rename(join(project, 'subtitle-localizer'), join(project, 'redirected-state-link'));
  const initialized = invoke(['init', '--input', input, '--project', project, '--job', 'demo']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const job = join(project, 'subtitle-localizer', 'jobs', 'demo');
  await rename(join(job, 'subtitles'), join(job, 'subtitles-original'));
  await symlink(victim, join(job, 'subtitles'), 'dir');
  const redirectedJob = invoke(['status', '--job', job]);
  assert.notEqual(redirectedJob.status, 0);
  assert.match(redirectedJob.stderr, /Symbolic links are not allowed/);
});

test('a project glossary change invalidates sibling jobs once and a no-op retry does not', async () => {
  const first = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  const input = join(first.project, 'demo.en.srt');
  const secondInit = invoke(['init', '--input', input, '--project', first.project, '--job', 'second']);
  assert.equal(secondInit.status, 0, secondInit.stderr);
  const second = join(first.project, 'subtitle-localizer', 'jobs', 'second');
  await writeFile(join(second, 'subtitles', 'semantic.zh-Hans.srt'), await readFile(join(ROOT, 'examples', 'demo', 'semantic.zh-Hans.srt')));
  const scaffolded = invoke(['review', 'scaffold', '--job', second]);
  assert.equal(scaffolded.status, 0, scaffolded.stderr);
  const reviewPath = join(second, 'qa', 'ai-review.json');
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  review.status = 'passed';
  review.reviewedAt = new Date().toISOString();
  review.coverage = [{ cueStart: 1, cueEnd: 20 }];
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  const secondJobPath = join(second, 'job.json');
  const secondJob = JSON.parse(await readFile(secondJobPath, 'utf8'));
  secondJob.phases.aiReview = { status: 'verified' };
  secondJob.phases.readable = { status: 'generated' };
  secondJob.phases.qa = { status: 'passed' };
  await writeFile(secondJobPath, `${JSON.stringify(secondJob, null, 2)}\n`, 'utf8');

  const decisionsPath = join(first.job, 'qa', 'term-decisions.json');
  const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
  decisions.terms.push({
    en: 'quiet interval',
    aliases: [],
    zhHans: '安静时段',
    category: 'concept',
    approvalStatus: 'approved',
    syncScope: 'project',
    status: 'user-approved',
    rationale: 'Project wording for a recurring concept.',
  });
  await writeFile(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
  await mkdir(join(first.project, 'subtitle-localizer', 'jobs', 'interrupted-without-job-json'));
  const applied = invoke(['glossary', 'apply', '--job', first.job]);
  assert.equal(applied.status, 0, applied.stderr);

  assert.equal(JSON.parse(await readFile(reviewPath, 'utf8')).status, 'pending');
  const invalidatedJob = JSON.parse(await readFile(secondJobPath, 'utf8'));
  assert.equal(invalidatedJob.phases.terminology.status, 'pending');
  assert.equal(invalidatedJob.phases.aiReview.status, 'pending');
  assert.equal(invalidatedJob.phases.readable.status, 'pending');
  assert.equal(invalidatedJob.phases.ass.status, 'not-requested');
  assert.equal(invalidatedJob.phases.qa.status, 'pending');
  const invalidatedDonor = JSON.parse(await readFile(join(first.job, 'job.json'), 'utf8'));
  assert.equal(invalidatedDonor.phases.readable.status, 'pending');
  assert.equal(invalidatedDonor.phases.ass.status, 'pending');
  const blockedQa = invoke(['qa', '--job', first.job]);
  assert.notEqual(blockedQa.status, 0);
  assert.match(blockedQa.stderr, /Run readable before final QA/);

  const restoredReview = { ...JSON.parse(await readFile(reviewPath, 'utf8')), status: 'passed', reviewedAt: new Date().toISOString(), coverage: [{ cueStart: 1, cueEnd: 20 }] };
  await writeFile(reviewPath, `${JSON.stringify(restoredReview, null, 2)}\n`, 'utf8');
  invalidatedJob.phases.aiReview = { status: 'verified' };
  invalidatedJob.phases.qa = { status: 'passed' };
  await writeFile(secondJobPath, `${JSON.stringify(invalidatedJob, null, 2)}\n`, 'utf8');
  const retried = invoke(['glossary', 'apply', '--job', first.job]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(await readFile(reviewPath, 'utf8')).status, 'passed');
  assert.equal(JSON.parse(await readFile(secondJobPath, 'utf8')).phases.qa.status, 'passed');
});

test('job-scoped terminology application leaves sibling review and QA intact', async () => {
  const first = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  const input = join(first.project, 'second.en.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nA terminal.\n', 'utf8');
  const initialized = invoke(['init', '--input', input, '--project', first.project, '--job', 'second']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const second = join(first.project, 'subtitle-localizer', 'jobs', 'second');
  const decisionsPath = join(second, 'qa', 'term-decisions.json');
  await writeFile(decisionsPath, `${JSON.stringify({
    schemaVersion: 1,
    job: 'second',
    completed: true,
    updatedAt: new Date().toISOString(),
    terms: [{
      en: 'terminal', aliases: [], zhHans: '航站楼', category: 'place', caseSensitive: false,
      approvalStatus: 'approved', syncScope: 'job', status: 'approved', rationale: 'Airport context.',
    }],
  }, null, 2)}\n`, 'utf8');
  const beforeReview = JSON.parse(await readFile(join(first.job, 'qa', 'ai-review.json'), 'utf8'));
  const beforeJob = JSON.parse(await readFile(join(first.job, 'job.json'), 'utf8'));
  const applied = invoke(['glossary', 'apply', '--job', second]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /changed: false/);
  assert.deepEqual(JSON.parse(await readFile(join(first.job, 'qa', 'ai-review.json'), 'utf8')), beforeReview);
  assert.deepEqual(JSON.parse(await readFile(join(first.job, 'job.json'), 'utf8')), beforeJob);
});

test('records terminology phase failure when final QA finds an active-term error', async () => {
  const result = await runNeutralSmoke({ cliPath: CLI, root: ROOT });
  const semanticPath = join(result.job, 'subtitles', 'semantic.zh-Hans.srt');
  const semantic = (await readFile(semanticPath, 'utf8')).replace('北风实验室', '风实验室');
  await writeFile(semanticPath, semantic, 'utf8');
  const failed = invoke(['qa', '--job', result.job]);
  assert.notEqual(failed.status, 0);
  const job = JSON.parse(await readFile(join(result.job, 'job.json'), 'utf8'));
  assert.equal(job.phases.terminology.status, 'failed');
});

test('rejects non-regular subtitle inputs without reading them', { skip: process.platform === 'win32' }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-cli-fifo-'));
  const input = join(project, 'captions.srt');
  const created = spawnSync('mkfifo', [input], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const result = invoke(['init', '--input', input, '--project', project]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular file/);

  const normalInput = join(project, 'normal.srt');
  await writeFile(normalInput, '1\n00:00:00,000 --> 00:00:01,000\nHello.\n', 'utf8');
  const initialized = invoke(['init', '--input', normalInput, '--project', project, '--job', 'fifo-state']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const job = join(project, 'subtitle-localizer', 'jobs', 'fifo-state');

  const assPath = join(job, 'subtitles', 'bilingual.zh-en.ass');
  const videoPath = join(project, 'video.mp4');
  const previewPath = join(project, 'preview.png');
  await writeFile(assPath, '[Script Info]\n', 'utf8');
  for (const [fifoPath, args] of [
    [assPath, ['ass', 'preview', '--job', job, '--video', videoPath, '--output', previewPath]],
    [videoPath, ['ass', 'preview', '--job', job, '--video', videoPath, '--output', previewPath]],
    [previewPath, ['ass', 'preview', '--job', job, '--video', videoPath, '--output', previewPath]],
  ]) {
    if (fifoPath === assPath) await rename(assPath, `${assPath}.backup`);
    else if (fifoPath === videoPath) await writeFile(assPath, '[Script Info]\n', 'utf8');
    else await writeFile(videoPath, '', 'utf8');
    const createdFifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(createdFifo.status, 0, createdFifo.stderr);
    const blockedPreview = invoke(args);
    assert.notEqual(blockedPreview.status, 0);
    assert.match(blockedPreview.stderr, /regular file/);
    await rename(fifoPath, `${fifoPath}.fifo`);
  }

  await rename(join(job, 'job.json'), join(job, 'job.backup.json'));
  const jobFifo = spawnSync('mkfifo', [join(job, 'job.json')], { encoding: 'utf8' });
  assert.equal(jobFifo.status, 0, jobFifo.stderr);
  const blockedState = invoke(['status', '--job', job]);
  assert.notEqual(blockedState.status, 0);
  assert.match(blockedState.stderr, /regular file/);
});

test('strips terminal control characters from untrusted error text', async () => {
  const result = invoke(['bad\nQA: PASS\r\u001b[2J\u202e']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.includes('\u001b'), false);
  assert.equal(result.stderr.includes('\u202e'), false);
  assert.equal(result.stderr.includes('\r'), false);
  assert.equal(result.stderr.includes('\nQA: PASS'), false);
  assert.match(result.stderr, /bad\\nQA: PASS/);
});
