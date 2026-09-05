import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBilingualAss } from '../skills/subtitle-me/scripts/lib/ass.mjs';
import { atomicWrite, atomicWriteJson, readJson, readUtf8, sourceFormsOverlap, utcNow } from '../skills/subtitle-me/scripts/lib/common.mjs';
import { applyDecisions, initializeGlossary, lintGlossary, lintTermFile } from '../skills/subtitle-me/scripts/lib/glossary.mjs';
import { initializeJob, jobArtifactPaths, loadJob } from '../skills/subtitle-me/scripts/lib/jobs.mjs';
import { activeTermsForJob, containsSourceTerm, createAiReviewScaffold, isTerminologyIssueCode, runQa, validateSegmentedLayer } from '../skills/subtitle-me/scripts/lib/qa.mjs';
import { createReadableLayers } from '../skills/subtitle-me/scripts/lib/readable.mjs';
import { parseSrt, writeSrt } from '../skills/subtitle-me/scripts/lib/subtitles.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('keeps proper-name terminology matching case-sensitive by default', () => {
  assert.equal(containsSourceTerm('You may continue.', 'May'), false);
  assert.equal(containsSourceTerm('May joined the call.', 'May'), true);
  assert.equal(containsSourceTerm('YOU MAY CONTINUE.', 'may', false), true);
  assert.equal(containsSourceTerm('The oﬃce is open.', 'office', false), true);
  assert.equal(sourceFormsOverlap('σ', false, 'ς', false), true);
  assert.equal(sourceFormsOverlap('ß', false, 'ẞ', false), true);
  const unicodeCollision = {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1,
    terms: [
      { id: 'eszett-lower', en: 'ß', aliases: [], caseSensitive: false, zhHans: '小写德语字母', approvalStatus: 'approved', syncScope: 'project' },
      { id: 'eszett-upper', en: 'ẞ', aliases: [], caseSensitive: false, zhHans: '大写德语字母', approvalStatus: 'approved', syncScope: 'project' },
    ],
  };
  assert.equal(lintGlossary(unicodeCollision).passed, false);
});

test('indexes Unicode case-insensitive source forms without losing final sigma or capital eszett', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-sigma-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nς is a Greek letter.\n\n2\n00:00:02,000 --> 00:00:04,000\nẞ is a German letter.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'sigma' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [
      { id: 'sigma', en: 'σ', aliases: [], caseSensitive: false, zhHans: '希格玛', category: 'letter', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Greek letter.' },
      { id: 'eszett', en: 'ß', aliases: [], caseSensitive: false, zhHans: '德语字母', category: 'letter', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'German letter.' },
    ],
  });
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'sigma', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, { schemaVersion: 1, job: 'sigma', completed: true, updatedAt: utcNow(), terms: [] });
  const semantic = '1\n00:00:00,000 --> 00:00:02,000\n这是一个希腊字母。\n\n2\n00:00:02,000 --> 00:00:04,000\n这是一个德语字符。\n';
  await atomicWrite(paths.semanticZh, semantic);
  await atomicWrite(paths.readableZh, semantic);
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'sigma', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 2 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'missing_active_term' && item.cue === 1), true);
  assert.equal(failed.errors.some((item) => item.code === 'missing_active_term' && item.cue === 2), true);
});

test('accepts canonically equivalent approved target terminology', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-target-normalization-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nCafe is open.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'cafe-target' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'cafe', en: 'Cafe', aliases: [], caseSensitive: true, zhHans: 'Café', category: 'place', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Brand spelling.' }],
  });
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'cafe-target', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, { schemaVersion: 1, job: 'cafe-target', completed: true, updatedAt: utcNow(), terms: [] });
  const semantic = '1\n00:00:00,000 --> 00:00:02,000\nCafe\u0301的面积是x²。\n';
  await atomicWrite(paths.semanticZh, semantic);
  await atomicWrite(paths.readableZh, semantic);
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'cafe-target', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const report = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(report.errors.some((item) => item.code === 'missing_active_term'), false);
  assert.equal(report.passed, true, JSON.stringify(report.errors, null, 2));

  await atomicWrite(paths.readableZh, semantic.replace('x²', 'x2'));
  const compatibilityDrift = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(compatibilityDrift.errors.some((item) => item.code === 'readable_text_drift'), true);

  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 2, updatedAt: utcNow(),
    terms: [{ id: 'cafe', en: 'Cafe', aliases: [], caseSensitive: true, zhHans: 'CO₂', category: 'place', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Subscript is significant.' }],
  });
  const compatibilityTerm = semantic.replace('Cafe\u0301', 'CO2');
  await atomicWrite(paths.semanticZh, compatibilityTerm);
  await atomicWrite(paths.readableZh, compatibilityTerm);
  const missingCompatibilityTerm = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(missingCompatibilityTerm.errors.some((item) => item.code === 'missing_active_term'), true);
});

test('lets a job-scoped contextual term override the same project term', () => {
  const projectTerm = { en: 'terminal', aliases: ['station terminal'], zhHans: '终端' };
  const jobTerm = { en: 'terminal', aliases: [], zhHans: '航站楼', approvalStatus: 'approved', syncScope: 'job' };
  assert.deepEqual(activeTermsForJob([projectTerm], [jobTerm]), [projectTerm, jobTerm]);
  assert.equal(isTerminologyIssueCode('missing_active_term'), true);
  assert.equal(isTerminologyIssueCode('project_term_not_applied'), true);
});

test('keeps distinct case-sensitive homonyms active and valid', () => {
  const projectTerm = { id: 'mercury-planet', en: 'Mercury', aliases: [], caseSensitive: true, zhHans: '水星', approvalStatus: 'approved', syncScope: 'project' };
  const jobTerm = { en: 'mercury', aliases: [], caseSensitive: true, zhHans: '汞', approvalStatus: 'approved', syncScope: 'job' };
  assert.deepEqual(activeTermsForJob([projectTerm], [jobTerm]), [projectTerm, jobTerm]);
  assert.equal(lintGlossary({ schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, terms: [projectTerm, { ...jobTerm, id: 'mercury-element', syncScope: 'project' }] }).passed, true);
  assert.equal(lintTermFile({ schemaVersion: 1, completed: true, terms: [projectTerm, jobTerm] }, { decisions: true }).passed, true);
  assert.equal(lintTermFile({ schemaVersion: 1, completed: true, terms: [projectTerm, { ...jobTerm, caseSensitive: false }] }, { decisions: true }).passed, false);
});

test('QA enforces both case-sensitive homonyms in their own source cues', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-case-homonyms-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nMercury is visible.\n\n2\n00:00:02,000 --> 00:00:04,000\nmercury is toxic.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'mercury' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'mercury-planet', en: 'Mercury', aliases: [], caseSensitive: true, zhHans: '水星', category: 'name', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Planet name.' }],
  });
  await atomicWriteJson(paths.termCandidates, {
    schemaVersion: 1, job: 'mercury', completed: true, updatedAt: utcNow(),
    terms: [{ en: 'mercury', aliases: [], caseSensitive: true, category: 'substance', cueIndexes: [2], reason: 'Element name.' }],
  });
  await atomicWriteJson(paths.termDecisions, {
    schemaVersion: 1, job: 'mercury', completed: true, updatedAt: utcNow(),
    terms: [{ en: 'mercury', aliases: [], caseSensitive: true, zhHans: '汞', category: 'substance', approvalStatus: 'approved', syncScope: 'job', status: 'approved', rationale: 'Element in this cue.' }],
  });
  const semantic = '1\n00:00:00,000 --> 00:00:02,000\n可以看到水星。\n\n2\n00:00:02,000 --> 00:00:04,000\n汞有毒。\n';
  await atomicWrite(paths.semanticZh, semantic);
  await atomicWrite(paths.readableZh, semantic);
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'mercury', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 2 }], issues: [], notes: 'Both cues reviewed.' });
  assert.equal((await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath })).passed, true);
  await atomicWrite(paths.semanticZh, semantic.replace('水星', '行星'));
  await atomicWrite(paths.readableZh, semantic.replace('水星', '行星'));
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'missing_active_term' && item.cue === 1), true);
});

test('QA applies a narrow case-sensitive job override only where it matches', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-narrow-override-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nTerminal is a heading.\n\n2\n00:00:02,000 --> 00:00:04,000\nThe terminal is open.\n\n3\n00:00:04,000 --> 00:00:06,000\nTerminal leads to the terminal.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'terminal' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'terminal', en: 'terminal', aliases: [], caseSensitive: false, zhHans: '终端', category: 'place', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Project default.' }],
  });
  await atomicWriteJson(paths.termCandidates, {
    schemaVersion: 1, job: 'terminal', completed: true, updatedAt: utcNow(),
    terms: [{ en: 'Terminal', aliases: [], caseSensitive: true, category: 'heading', cueIndexes: [1], reason: 'Heading capitalization.' }],
  });
  await atomicWriteJson(paths.termDecisions, {
    schemaVersion: 1, job: 'terminal', completed: true, updatedAt: utcNow(),
    terms: [{ en: 'Terminal', aliases: [], caseSensitive: true, zhHans: '航站楼', category: 'heading', approvalStatus: 'approved', syncScope: 'job', status: 'approved', rationale: 'Heading wording.' }],
  });
  const semantic = '1\n00:00:00,000 --> 00:00:02,000\n“航站楼”是标题。\n\n2\n00:00:02,000 --> 00:00:04,000\n终端已开放。\n\n3\n00:00:04,000 --> 00:00:06,000\n航站楼通往终端。\n';
  await atomicWrite(paths.semanticZh, semantic);
  await atomicWrite(paths.readableZh, semantic);
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'terminal', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 3 }], issues: [], notes: 'Both cases reviewed.' });
  assert.equal((await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath })).passed, true);
  const wrongLowercase = semantic.replace('终端已开放', '设备已开放');
  await atomicWrite(paths.semanticZh, wrongLowercase);
  await atomicWrite(paths.readableZh, wrongLowercase);
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'missing_active_term' && item.cue === 2), true);
  const wrongMixedCue = semantic.replace('航站楼通往终端', '航站楼通往设备');
  await atomicWrite(paths.semanticZh, wrongMixedCue);
  await atomicWrite(paths.readableZh, wrongMixedCue);
  const mixedFailure = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(mixedFailure.errors.some((item) => item.code === 'missing_active_term' && item.cue === 3), true);
});

test('defaults non-ASCII uppercase terminology to case-sensitive', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-unicode-case-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\néclair is open.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'eclair' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'eclair', en: 'éclair', aliases: [], caseSensitive: false, zhHans: '泡芙店', category: 'place', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Project default.' }],
  });
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'eclair', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, {
    schemaVersion: 1, job: 'eclair', completed: true, updatedAt: utcNow(),
    terms: [{ en: 'Éclair', aliases: [], zhHans: '闪电', category: 'name', approvalStatus: 'approved', syncScope: 'job', status: 'approved', rationale: 'Capitalized proper name.' }],
  });
  const semantic = '1\n00:00:00,000 --> 00:00:02,000\n闪电已开放。\n';
  await atomicWrite(paths.semanticZh, semantic);
  await atomicWrite(paths.readableZh, semantic);
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'eclair', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'missing_active_term' && item.cue === 1), true);
});

test('matches source terminology across Unicode normalization forms', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-unicode-normalization-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nCafe\u0301 is open.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'cafe' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'cafe', en: 'Café', aliases: [], zhHans: '咖啡馆', category: 'place', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Project name.' }],
  });
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'cafe', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, { schemaVersion: 1, job: 'cafe', completed: true, updatedAt: utcNow(), terms: [] });
  const semantic = '1\n00:00:00,000 --> 00:00:02,000\n这里已开放。\n';
  await atomicWrite(paths.semanticZh, semantic);
  await atomicWrite(paths.readableZh, semantic);
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'cafe', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'missing_active_term' && item.cue === 1), true);
});

test('matches a multiword project term across a source cue line break', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-multiline-term-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nFocus\nMode is enabled.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'focus-mode' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'focus-mode', en: 'Focus Mode', aliases: [], caseSensitive: true, zhHans: '专注模式', category: 'feature', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Feature name.' }],
  });
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'focus-mode', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, { schemaVersion: 1, job: 'focus-mode', completed: true, updatedAt: utcNow(), terms: [] });
  const semantic = '1\n00:00:00,000 --> 00:00:02,000\n该功能已启用。\n';
  await atomicWrite(paths.semanticZh, semantic);
  await atomicWrite(paths.readableZh, semantic);
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'focus-mode', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'missing_active_term'), true);
});

test('does not let a narrow case-sensitive decision resolve a broad candidate', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-directional-candidate-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nmercury is toxic.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'mercury' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(paths.termCandidates, {
    schemaVersion: 1, job: 'mercury', completed: true, updatedAt: utcNow(),
    terms: [{ en: 'mercury', aliases: [], caseSensitive: false, category: 'substance', cueIndexes: [1], reason: 'Element name.' }],
  });
  await atomicWriteJson(paths.termDecisions, {
    schemaVersion: 1, job: 'mercury', completed: true, updatedAt: utcNow(),
    terms: [{ en: 'Mercury', aliases: [], caseSensitive: true, zhHans: '水星', category: 'name', approvalStatus: 'approved', syncScope: 'job', status: 'approved', rationale: 'Planet name only.' }],
  });
  const semantic = '1\n00:00:00,000 --> 00:00:02,000\n这种物质有毒。\n';
  await atomicWrite(paths.semanticZh, semantic);
  await atomicWrite(paths.readableZh, semantic);
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'mercury', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'candidate_without_decision'), true);
});

test('rejects gaps or overlaps between readable child cues', () => {
  const master = [{ start: 0, end: 4, text: 'abcdef' }];
  for (const secondStart of [1.2, 0.8]) {
    const issues = [];
    validateSegmentedLayer(master, [
      { start: 0, end: 1, text: 'abc' },
      { start: secondStart, end: 4, text: 'def' },
    ], issues);
    assert.equal(issues.some((item) => item.code === 'readable_internal_timing'), true);
  }
});

test('rejects an approved target term split across readable cue boundaries', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-term-boundary-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:04,000\nThe mountain laboratory is open.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'boundary' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'mountain-laboratory', en: 'mountain laboratory', aliases: [], caseSensitive: false, zhHans: '山中实验室', category: 'place', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Project name.' }],
  });
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'boundary', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, { schemaVersion: 1, job: 'boundary', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWrite(paths.semanticZh, '1\n00:00:00,000 --> 00:00:04,000\n山中实验室已开放。\n');
  await atomicWrite(paths.readableZh, '1\n00:00:00,000 --> 00:00:02,000\n山中\n\n2\n00:00:02,000 --> 00:00:04,000\n实验室已开放。\n');
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'boundary', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'term_split_across_cues'), true);
  await atomicWrite(paths.readableZh, '1\n00:00:00,000 --> 00:00:04,000\n山中\n实验室已开放。\n');
  const lineFailure = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(lineFailure.errors.some((item) => item.code === 'term_split_across_cues'), true);
});

test('maps protected target boundaries from canonically equivalent readable text', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-normalized-boundary-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:04,000\nUse AI at the Cafe.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'normalized-boundary' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'ai', en: 'AI', aliases: [], caseSensitive: true, zhHans: 'AI', category: 'technology', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Approved abbreviation.' }],
  });
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'normalized-boundary', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, { schemaVersion: 1, job: 'normalized-boundary', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWrite(paths.semanticZh, '1\n00:00:00,000 --> 00:00:04,000\nCaféAI\n');
  await atomicWrite(paths.readableZh, '1\n00:00:00,000 --> 00:00:02,000\nCafe\u0301A\n\n2\n00:00:02,000 --> 00:00:04,000\nI\n');
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'normalized-boundary', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'term_split_across_cues'), true);
});

test('rejects grapheme splits even when the project glossary is empty', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-grapheme-boundary-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:04,000\nTest an emoji sequence.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'grapheme-boundary' });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'grapheme-boundary', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, { schemaVersion: 1, job: 'grapheme-boundary', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWrite(paths.semanticZh, '1\n00:00:00,000 --> 00:00:04,000\n测试👩‍💻字符。\n');
  await atomicWrite(paths.readableZh, '1\n00:00:00,000 --> 00:00:02,000\n测试👩\n\n2\n00:00:02,000 --> 00:00:04,000\n‍💻字符。\n');
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'grapheme-boundary', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'grapheme_split_across_cues'), true);
});

test('rejects an approved source term split across bilingual English cues', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-source-term-boundary-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:04,000\nThe mountain laboratory is open.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'source-boundary', bilingualAss: true });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  await atomicWriteJson(glossaryPath, {
    schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-Hans', revision: 1, updatedAt: utcNow(),
    terms: [{ id: 'mountain-laboratory', en: 'mountain laboratory', aliases: [], caseSensitive: false, zhHans: '山中实验室', category: 'place', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Project name.' }],
  });
  await atomicWriteJson(paths.termCandidates, { schemaVersion: 1, job: 'source-boundary', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWriteJson(paths.termDecisions, { schemaVersion: 1, job: 'source-boundary', completed: true, updatedAt: utcNow(), terms: [] });
  await atomicWrite(paths.semanticZh, '1\n00:00:00,000 --> 00:00:04,000\n山中实验室已经开放。\n');
  const readableZh = '1\n00:00:00,000 --> 00:00:02,000\n山中实验室\n\n2\n00:00:02,000 --> 00:00:04,000\n已经开放。\n';
  const readableEn = '1\n00:00:00,000 --> 00:00:02,000\nThe mountain\n\n2\n00:00:02,000 --> 00:00:04,000\nlaboratory is open.\n';
  await atomicWrite(paths.readableZh, readableZh);
  await atomicWrite(paths.readableEn, readableEn);
  await atomicWrite(paths.ass, buildBilingualAss({ zhCues: parseSrt(readableZh), enCues: parseSrt(readableEn) }));
  await atomicWriteJson(paths.aiReview, { schemaVersion: 1, job: 'source-boundary', status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.' });
  const failed = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(failed.errors.some((item) => item.code === 'source_term_split_across_cues'), true);
});

test('runs the neutral 20-cue fixture from an empty glossary to passing QA', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-'));
  const input = join(project, 'demo.en.srt');
  await copyFile(join(ROOT, 'examples', 'demo', 'source.en.srt'), input);
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'demo', bilingualAss: true });
  const paths = jobArtifactPaths(initialized.jobPath);
  const glossaryPath = join(project, 'subtitle-localizer', 'glossary.json');
  assert.equal((await readJson(glossaryPath)).terms.length, 0);
  assert.equal(Object.hasOwn(initialized.job.source, 'sha256'), false);

  await copyFile(join(ROOT, 'examples', 'demo', 'term-candidates.json'), paths.termCandidates);
  await copyFile(join(ROOT, 'examples', 'demo', 'term-decisions.json'), paths.termDecisions);
  const applied = await applyDecisions({ glossaryPath, decisionsPath: paths.termDecisions });
  assert.equal(applied.changes.length, 3);
  assert.equal((await readJson(glossaryPath)).revision, 1);

  await copyFile(join(ROOT, 'examples', 'demo', 'semantic.zh-Hans.srt'), paths.semanticZh);
  const readable = createReadableLayers({
    sourceCues: parseSrt(await readUtf8(paths.source)),
    semanticZhCues: parseSrt(await readUtf8(paths.semanticZh)),
    glossaryTerms: (await readJson(glossaryPath)).terms,
    bilingualAss: true,
  });
  await atomicWrite(paths.readableZh, writeSrt(readable.readableZh));
  await atomicWrite(paths.readableEn, writeSrt(readable.readableEn));
  await atomicWrite(paths.ass, buildBilingualAss({
    zhCues: readable.readableZh,
    enCues: readable.readableEn,
  }));
  assert.equal((await readUtf8(paths.ass)).includes('SHA256'), false);

  const review = await createAiReviewScaffold({ jobPath: initialized.jobPath, glossaryPath });
  assert.equal(Object.keys(review).some((key) => /sha|hash/i.test(key)), false);
  await atomicWriteJson(paths.aiReview, {
    ...review,
    status: 'passed',
    reviewedAt: utcNow(),
    coverage: [{ cueStart: 1, cueEnd: 20 }],
    issues: [],
    notes: 'Fixture review checked fidelity, terminology, names, numbers, and natural Chinese.',
  });
  const report = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(report.passed, true, JSON.stringify(report.errors, null, 2));
  assert.equal(Object.hasOwn(report, 'hashes'), false);
  assert.equal(report.stats.sourceCues, 20);
  assert.deepEqual(report.warnings.map((item) => item.code), ['approved_latin']);
  assert.equal((await readFile(paths.report, 'utf8')).includes('**PASS**'), true);

  await atomicWriteJson(paths.aiReview, { ...review, status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 20 }], issues: 'Unresolved issue' });
  const malformedReviewQa = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(malformedReviewQa.passed, false);
  assert.equal(malformedReviewQa.errors.some((item) => item.code === 'ai_review_issues_invalid'), true);
  await atomicWriteJson(paths.aiReview, { ...review, status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 20 }], issues: [] });

  const originalReadableEn = await readFile(paths.readableEn, 'utf8');
  const alteredEnglish = parseSrt(originalReadableEn);
  alteredEnglish[0].text = 'Altered English.';
  await atomicWrite(paths.readableEn, writeSrt(alteredEnglish));
  const englishTamper = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(englishTamper.passed, false);
  assert.equal(englishTamper.errors.some((item) => item.code === 'readable_en_text_drift'), true);
  await atomicWrite(paths.readableEn, originalReadableEn);

  const originalAss = await readFile(paths.ass, 'utf8');
  await atomicWrite(paths.readableEn, originalReadableEn.replace('testing', 'test ing'));
  await atomicWrite(paths.ass, buildBilingualAss({ zhCues: readable.readableZh, enCues: parseSrt(await readUtf8(paths.readableEn)) }));
  const englishWordDrift = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(englishWordDrift.errors.some((item) => item.code === 'readable_en_text_drift'), true);
  await atomicWrite(paths.readableEn, originalReadableEn);
  await atomicWrite(paths.ass, originalAss);
  await atomicWrite(paths.ass, originalAss.replace('Noto Sans CJK SC', 'Arial,100'));
  const malformedStyle = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(malformedStyle.errors.some((item) => item.code === 'ass_style_invalid'), true);
  await atomicWrite(paths.ass, originalAss);
  await atomicWrite(paths.ass, originalAss.replace(/^Dialogue:.*$/gm, ''));
  const assTamper = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(assTamper.passed, false);
  assert.equal(assTamper.errors.some((item) => item.code === 'ass_event_count'), true);
  await atomicWrite(paths.ass, originalAss);
  await atomicWrite(paths.ass, originalAss.replaceAll('{\\q2}', '{\\q2\\alpha&HFF&}'));
  const hiddenAss = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(hiddenAss.passed, false);
  assert.equal(hiddenAss.errors.some((item) => item.code === 'ass_structure_drift'), true);
  await atomicWrite(paths.ass, originalAss);

  const originalCandidatesText = await readFile(paths.termCandidates, 'utf8');
  const originalCandidates = JSON.parse(originalCandidatesText);
  const changedCandidates = structuredClone(originalCandidates);
  changedCandidates.terms[0].cueIndexes = [999];
  await atomicWriteJson(paths.termCandidates, changedCandidates);
  const changedCandidateQa = await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath });
  assert.equal(changedCandidateQa.errors.some((item) => item.code === 'term_candidate_range'), true);
  await atomicWrite(paths.termCandidates, originalCandidatesText);
  assert.equal((await runQa({ jobPath: initialized.jobPath, job: initialized.job, glossaryPath })).passed, true);
});

test('rejects explicit job slug collisions and refreshes a changed normalized source on re-init', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-collision-'));
  const firstInput = join(project, 'first.srt');
  const secondInput = join(project, 'second.srt');
  await writeFile(firstInput, '1\n00:00:00,000 --> 00:00:02,000\nFirst.\n', 'utf8');
  await writeFile(secondInput, '1\n00:00:00,000 --> 00:00:02,000\nSecond.\n', 'utf8');
  const first = await initializeJob({ projectRoot: project, inputPath: firstInput, requestedId: 'C++' });
  await assert.rejects(
    () => initializeJob({ projectRoot: project, inputPath: secondInput, requestedId: 'C#' }),
    /already belongs to another source/,
  );
  await atomicWrite(jobArtifactPaths(first.jobPath).source, '1\n00:00:00,000 --> 00:00:02,000\nTampered.\n');
  const refreshed = await initializeJob({ projectRoot: project, inputPath: firstInput, requestedId: 'C++' });
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.resumed, false);
  assert.equal(refreshed.job.phases.translation.status, 'pending');
  assert.match(await readUtf8(jobArtifactPaths(first.jobPath).source), /First\./);
});

test('generates collision-resistant ids for punctuation-heavy terminology', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-term-ids-'));
  const stateRoot = join(project, 'subtitle-localizer');
  const { glossaryPath } = await initializeGlossary(stateRoot);
  const decisionsPath = join(stateRoot, 'decisions.json');
  const base = { aliases: [], category: 'language', approvalStatus: 'approved', syncScope: 'project', status: 'approved', rationale: 'Distinct language name.' };
  await atomicWriteJson(decisionsPath, {
    schemaVersion: 1,
    job: 'term-ids',
    completed: true,
    updatedAt: utcNow(),
    terms: [
      { ...base, en: 'C++', zhHans: 'C++' },
      { ...base, en: 'C#', zhHans: 'C#' },
    ],
  });
  await applyDecisions({ glossaryPath, decisionsPath });
  const ids = (await readJson(glossaryPath)).terms.map((term) => term.id);
  assert.deepEqual(ids.sort(), ['c', 'c-2']);
});

test('runs shared-job invalidation before committing a project glossary change', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-glossary-order-'));
  const stateRoot = join(project, 'subtitle-localizer');
  const { glossaryPath } = await initializeGlossary(stateRoot);
  const decisionsPath = join(stateRoot, 'decisions.json');
  await atomicWriteJson(decisionsPath, {
    schemaVersion: 1,
    job: 'order',
    completed: true,
    updatedAt: utcNow(),
    terms: [{
      en: 'Focus Mode', aliases: [], zhHans: '专注模式', category: 'feature', approvalStatus: 'approved',
      syncScope: 'project', status: 'approved', rationale: 'Project feature name.',
    }],
  });
  await assert.rejects(
    () => applyDecisions({ glossaryPath, decisionsPath, beforeProjectChange: () => { throw new Error('invalidation failed'); } }),
    /invalidation failed/,
  );
  assert.equal((await readJson(glossaryPath)).revision, 0);
  let invalidated = false;
  const applied = await applyDecisions({ glossaryPath, decisionsPath, beforeProjectChange: () => { invalidated = true; } });
  assert.equal(invalidated, true);
  assert.equal(applied.changed, true);
  assert.equal((await readJson(glossaryPath)).revision, 1);

  await atomicWriteJson(decisionsPath, {
    schemaVersion: 1,
    job: 'order',
    completed: true,
    updatedAt: utcNow(),
    terms: [{
      en: 'Quiet Mode', aliases: ['focus mode'], caseSensitive: false, zhHans: '安静模式', category: 'feature', approvalStatus: 'approved',
      syncScope: 'project', status: 'approved', rationale: 'Conflicts with an existing project term only after merge.',
    }],
  });
  invalidated = false;
  await assert.rejects(
    () => applyDecisions({ glossaryPath, decisionsPath, beforeProjectChange: () => { invalidated = true; } }),
    /invalid glossary/i,
  );
  assert.equal(invalidated, false);
  assert.equal((await readJson(glossaryPath)).revision, 1);
});

test('refreshes the job when init sees changed source text', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-refresh-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nHello.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input });
  const paths = jobArtifactPaths(initialized.jobPath);
  await atomicWriteJson(paths.termCandidates, {
    schemaVersion: 1, job: initialized.job.id, completed: true, updatedAt: utcNow(),
    terms: [{ en: 'Hello', aliases: [], caseSensitive: true, category: 'term', cueIndexes: [1], reason: 'Source term.' }],
  });
  await atomicWriteJson(paths.termDecisions, {
    schemaVersion: 1, job: initialized.job.id, completed: true, updatedAt: utcNow(),
    terms: [{ en: 'Hello', aliases: [], caseSensitive: true, zhHans: '你好', category: 'term', approvalStatus: 'approved', syncScope: 'job', status: 'approved', rationale: 'Job wording.' }],
  });
  await atomicWriteJson(paths.aiReview, {
    schemaVersion: 1, job: initialized.job.id, status: 'passed', reviewedAt: utcNow(), coverage: [{ cueStart: 1, cueEnd: 1 }], issues: [], notes: 'Reviewed.',
  });
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nChanged.\n', 'utf8');
  const refreshed = await initializeJob({ projectRoot: project, inputPath: input });
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.job.phases.translation.status, 'pending');
  assert.match(await readUtf8(jobArtifactPaths(initialized.jobPath).source), /Changed\./);
  assert.equal((await readJson(paths.termCandidates)).previousCandidates.terms[0].en, 'Hello');
  assert.equal((await readJson(paths.termDecisions)).previousDecisions.terms[0].zhHans, '你好');
  assert.equal((await readJson(paths.aiReview)).previousReview.status, 'passed');
});

test('recovers an interrupted source refresh and rebinds identical moved input', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-refresh-recovery-'));
  const input = join(project, 'source.srt');
  const movedInput = join(project, 'moved.srt');
  const firstText = '1\n00:00:00,000 --> 00:00:02,000\nHello.\n';
  const changedText = '1\n00:00:00,000 --> 00:00:02,000\nChanged.\n';
  await writeFile(input, firstText, 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'demo' });
  const jobFile = join(initialized.jobPath, 'job.json');
  const interrupted = await readJson(jobFile);
  interrupted.phases.normalized = { status: 'refreshing' };
  interrupted.phases.translation = { status: 'verified' };
  interrupted.phases.qa = { status: 'passed' };
  await atomicWriteJson(jobFile, interrupted);
  await atomicWrite(jobArtifactPaths(initialized.jobPath).source, changedText);
  await writeFile(input, changedText, 'utf8');

  const recovered = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'demo' });
  assert.equal(recovered.refreshed, true);
  assert.equal(recovered.resumed, false);
  assert.equal(recovered.job.phases.normalized.status, 'verified');
  assert.equal(recovered.job.phases.translation.status, 'pending');
  assert.equal(recovered.job.phases.qa.status, 'pending');

  await writeFile(movedInput, changedText, 'utf8');
  const rebound = await initializeJob({ projectRoot: project, inputPath: movedInput, requestedId: 'demo' });
  assert.equal(rebound.resumed, true);
  assert.equal(rebound.job.source.originalPath, movedInput);
});

test('refuses to open a job from a newer schema', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-schema-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nHello.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: 'demo' });
  const jobFile = join(initialized.jobPath, 'job.json');
  const futureJob = await readJson(jobFile);
  futureJob.schemaVersion = 999;
  await atomicWriteJson(jobFile, futureJob);
  await assert.rejects(
    () => initializeJob({ projectRoot: project, inputPath: input, requestedId: 'demo' }),
    /Unsupported job schema 999/,
  );
});

test('keeps automatic jobs distinct for identical same-named inputs and resets a requested title on refresh', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-distinct-inputs-'));
  const firstDir = join(project, 'video-a');
  const secondDir = join(project, 'video-b');
  await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
  const subtitle = '1\n00:00:00,000 --> 00:00:02,000\nSame captions.\n';
  const firstInput = join(firstDir, 'captions.srt');
  const secondInput = join(secondDir, 'captions.srt');
  await writeFile(firstInput, subtitle, 'utf8');
  await writeFile(secondInput, subtitle, 'utf8');
  const first = await initializeJob({ projectRoot: project, inputPath: firstInput, chineseTitle: true });
  const second = await initializeJob({ projectRoot: project, inputPath: secondInput });
  assert.notEqual(first.jobPath, second.jobPath);
  assert.equal(second.job.id, 'captions-2');

  await atomicWrite(jobArtifactPaths(first.jobPath).title, 'Original: Old title\nChinese: 旧标题\n');
  await writeFile(firstInput, subtitle.replace('Same captions.', 'Changed captions.'), 'utf8');
  await initializeJob({ projectRoot: project, inputPath: firstInput, requestedId: first.job.id, chineseTitle: true });
  assert.equal(await readUtf8(jobArtifactPaths(first.jobPath).title), 'Original: \nChinese: \n');

  await atomicWrite(jobArtifactPaths(first.jobPath).title, 'Original: Older title\nChinese: 更旧标题\n');
  await initializeJob({ projectRoot: project, inputPath: firstInput, requestedId: first.job.id, chineseTitle: false });
  await writeFile(firstInput, subtitle.replace('Same captions.', 'Third captions.'), 'utf8');
  await initializeJob({ projectRoot: project, inputPath: firstInput, requestedId: first.job.id, chineseTitle: false });
  assert.equal(await readUtf8(jobArtifactPaths(first.jobPath).title), 'Original: \nChinese: \n');
  await initializeJob({ projectRoot: project, inputPath: firstInput, requestedId: first.job.id, chineseTitle: true });
  assert.equal(await readUtf8(jobArtifactPaths(first.jobPath).title), 'Original: \nChinese: \n');
});

test('keeps a supplementary Unicode character intact at the job-id limit', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-unicode-id-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nHello.\n', 'utf8');
  const initialized = await initializeJob({ projectRoot: project, inputPath: input, requestedId: `${'a'.repeat(47)}𐐀` });
  const loaded = await loadJob(initialized.jobPath);
  assert.equal([...loaded.job.id].length, 48);
  assert.equal(loaded.job.id.includes('\uFFFD'), false);
});

test('preserves omitted options and resets only dependent phases when an option changes', async () => {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-me-options-'));
  const input = join(project, 'source.srt');
  await writeFile(input, '1\n00:00:00,000 --> 00:00:02,000\nHello.\n', 'utf8');
  const first = await initializeJob({ projectRoot: project, inputPath: input, bilingualAss: false, chineseTitle: false });
  const jobFile = join(first.jobPath, 'job.json');
  const manuallyCompleted = await readJson(jobFile);
  manuallyCompleted.phases.readable = { status: 'generated' };
  manuallyCompleted.phases.qa = { status: 'passed' };
  await atomicWriteJson(jobFile, manuallyCompleted);

  const changed = await initializeJob({ projectRoot: project, inputPath: input, bilingualAss: true, chineseTitle: true });
  assert.equal(changed.job.phases.readable.status, 'pending');
  assert.equal(changed.job.phases.ass.status, 'pending');
  assert.equal(changed.job.phases.qa.status, 'pending');

  const preserved = await initializeJob({ projectRoot: project, inputPath: input });
  assert.equal(preserved.job.options.bilingualAss, true);
  assert.equal(preserved.job.options.chineseTitle, true);
});
