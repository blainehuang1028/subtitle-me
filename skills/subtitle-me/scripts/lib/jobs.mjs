import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  assertNoSymlinkPath,
  atomicWrite,
  atomicWriteJson,
  canonicalDirectory,
  ensureDir,
  pathExists,
  readJson,
  readUtf8,
  slugify,
  UserError,
  utcNow,
} from './common.mjs';
import { emptyTermCandidates, emptyTermDecisions, initializeGlossary } from './glossary.mjs';
import { findTimelineIssues, parseSubtitleFile, writeSrt } from './subtitles.mjs';

export const JOB_SCHEMA_VERSION = 1;

const JOB_ARTIFACT_LAYOUT = {
  source: 'source/source.en.srt',
  semanticZh: 'subtitles/semantic.zh-Hans.srt',
  readableZh: 'subtitles/readable.zh-Hans.srt',
  readableEn: 'subtitles/readable.en.srt',
  ass: 'subtitles/bilingual.zh-en.ass',
  termCandidates: 'qa/term-candidates.json',
  termDecisions: 'qa/term-decisions.json',
  aiReview: 'qa/ai-review.json',
  qa: 'qa/qa.json',
  report: 'report.md',
  title: 'title.zh-Hans.md',
  description: 'description.zh-Hans.md',
  preview: 'preview.png',
};

function assertSupportedJob(job, jobPath) {
  if (job.schemaVersion !== JOB_SCHEMA_VERSION) {
    throw new UserError(`Unsupported job schema ${String(job.schemaVersion)} in ${jobPath}; expected ${JOB_SCHEMA_VERSION}`);
  }
  return job;
}

export function stateRootFor(projectRoot) {
  return join(resolve(projectRoot), 'subtitle-localizer');
}

export async function resolveStateRootFor(projectRoot) {
  const project = await canonicalDirectory(projectRoot, 'Project directory');
  const stateRoot = stateRootFor(project);
  await assertNoSymlinkPath(project, stateRoot);
  return stateRoot;
}

async function assertSafeStatePath(stateRoot, target) {
  return assertNoSymlinkPath(dirname(stateRoot), target);
}

async function assertKnownJobPaths(stateRoot, jobPath) {
  const relativePaths = ['', 'job.json', 'source', 'subtitles', 'qa', ...Object.values(JOB_ARTIFACT_LAYOUT)];
  for (const relativePath of relativePaths) {
    await assertSafeStatePath(stateRoot, relativePath ? join(jobPath, relativePath) : jobPath);
  }
}

export async function resolveJobPath(value) {
  const absolute = resolve(value);
  const lexicalCandidate = basename(absolute) === 'job.json' ? dirname(absolute) : absolute;
  if (basename(dirname(lexicalCandidate)) !== 'jobs' || basename(dirname(dirname(lexicalCandidate))) !== 'subtitle-localizer') {
    throw new UserError(`Job must be located at <project>/subtitle-localizer/jobs/<job-id>: ${lexicalCandidate}`);
  }
  const lexicalStateRoot = dirname(dirname(lexicalCandidate));
  const lexicalProject = dirname(lexicalStateRoot);
  const project = await canonicalDirectory(lexicalProject, 'Project directory');
  const candidate = join(project, relative(lexicalProject, lexicalCandidate));
  const stateRoot = stateRootFor(project);
  await assertKnownJobPaths(stateRoot, candidate);
  if (!(await pathExists(join(candidate, 'job.json')))) throw new UserError(`No job.json found in ${candidate}`);
  const job = assertSupportedJob(await readJson(join(candidate, 'job.json')), candidate);
  if (job.id !== basename(candidate)) throw new UserError(`job.json id does not match its directory: ${candidate}`);
  return candidate;
}

export async function loadJob(jobPath) {
  const resolved = await resolveJobPath(jobPath);
  const job = assertSupportedJob(await readJson(join(resolved, 'job.json')), resolved);
  return { path: resolved, job };
}

export async function saveJob(jobPath, job) {
  const next = { ...job, updatedAt: utcNow() };
  await atomicWriteJson(join(jobPath, 'job.json'), next);
  return next;
}

function pendingPhases(bilingualAss) {
  return {
    normalized: { status: 'verified' },
    terminology: { status: 'pending' },
    translation: { status: 'pending' },
    aiReview: { status: 'pending' },
    readable: { status: 'pending' },
    ass: { status: bilingualAss ? 'pending' : 'not-requested' },
    qa: { status: 'pending' },
  };
}

function resetTerminologyRecord(emptyRecord, current, previousKey, reason) {
  const previous = current?.completed || current?.terms?.length > 0
    ? {
        completed: current.completed,
        updatedAt: current.updatedAt,
        terms: current.terms,
        invalidatedAt: utcNow(),
        reason,
      }
    : current?.[previousKey];
  return { ...emptyRecord, ...(previous ? { [previousKey]: previous } : {}) };
}

async function sourceMatchesJob(jobPath, inputPath, normalized, allowContentMatch) {
  const existing = assertSupportedJob(await readJson(join(jobPath, 'job.json')), jobPath);
  if (resolve(existing.source?.originalPath ?? '') === resolve(inputPath)) return true;
  if (!allowContentMatch) return false;
  const existingNormalized = join(jobPath, 'source', 'source.en.srt');
  return await pathExists(existingNormalized) && await readUtf8(existingNormalized) === normalized;
}

async function chooseJobId(stateRoot, requestedId, inputPath, normalized) {
  if (requestedId) {
    const requested = slugify(requestedId);
    const requestedPath = join(stateRoot, 'jobs', requested);
    await assertKnownJobPaths(stateRoot, requestedPath);
    if (!(await pathExists(join(requestedPath, 'job.json')))) return requested;
    if (await sourceMatchesJob(requestedPath, inputPath, normalized, true)) return requested;
    throw new UserError(`Job id "${requestedId}" resolves to "${requested}", which already belongs to another source. Choose a different --job value.`);
  }

  const base = slugify(basename(inputPath, extname(inputPath)));
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const candidateFile = join(stateRoot, 'jobs', candidate, 'job.json');
    await assertKnownJobPaths(stateRoot, dirname(candidateFile));
    if (!(await pathExists(candidateFile))) return candidate;
    if (await sourceMatchesJob(dirname(candidateFile), inputPath, normalized, false)) return candidate;
  }
}

export async function initializeJob({ projectRoot, inputPath, requestedId, bilingualAss, chineseTitle, videoDescription }) {
  const project = await canonicalDirectory(projectRoot, 'Project directory');
  const source = resolve(inputPath);
  if (!(await pathExists(source))) throw new UserError(`Subtitle file not found: ${source}`);
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile()) throw new UserError(`Subtitle input must be a regular file: ${source}`);
  const sourceBytes = sourceInfo.size;
  if (sourceBytes > 32 * 1024 * 1024) throw new UserError(`Subtitle file is ${(sourceBytes / 1024 / 1024).toFixed(1)} MiB; the v0.1 limit is 32 MiB.`);

  const stateRoot = await resolveStateRootFor(project);
  await assertSafeStatePath(stateRoot, join(stateRoot, 'README.md'));
  await initializeGlossary(stateRoot);
  const stateReadme = join(stateRoot, 'README.md');
  if (!(await pathExists(stateReadme))) {
    await atomicWrite(stateReadme, `# Subtitle Localizer\n\nThis visible directory is owned by your project. It is not part of the installed skill.\n\n- \`glossary.json\` is the machine-readable terminology authority.\n- \`glossary.md\` is generated for people to read.\n- \`glossary.changes.jsonl\` records applied terminology changes.\n- \`jobs/<job-id>/\` contains source normalization, translations, optional ASS, QA, and \`job.json\`.\n\nDo not edit \`glossary.md\` to change terminology. Use the job decision file and the glossary apply command. After editing an artifact, rerun its downstream steps and final QA.\n`);
  }

  const parsed = await parseSubtitleFile(source);
  if (parsed.cues.length > 20_000) throw new UserError(`Subtitle file has ${parsed.cues.length} cues; the v0.1 limit is 20,000.`);
  const oversizedCue = parsed.cues.find((item) => item.text.length > 4000);
  if (oversizedCue) throw new UserError(`Subtitle cue ${oversizedCue.sourceIndex} exceeds the v0.1 limit of 4,000 characters.`);
  const normalized = writeSrt(parsed.cues);
  const jobId = await chooseJobId(stateRoot, requestedId, source, normalized);
  const jobPath = join(stateRoot, 'jobs', jobId);
  const jobFile = join(jobPath, 'job.json');
  const normalizedPath = join(jobPath, 'source', 'source.en.srt');
  const existing = (await pathExists(jobFile)) ? assertSupportedJob(await readJson(jobFile), jobPath) : null;
  const existingNormalized = existing && await pathExists(normalizedPath) ? await readUtf8(normalizedPath) : null;
  const sourceChanged = Boolean(existing && existingNormalized !== normalized);
  const refreshIncomplete = existing?.phases?.normalized?.status === 'refreshing';
  const effectiveBilingualAss = bilingualAss ?? existing?.options?.bilingualAss ?? false;
  const effectiveDescription = videoDescription ?? existing?.options?.videoDescription ?? false;
  const effectiveChineseTitle = chineseTitle ?? existing?.options?.chineseTitle ?? false;
  const optionsChanged = Boolean(existing && (
    existing.options?.bilingualAss !== effectiveBilingualAss
    || existing.options?.chineseTitle !== effectiveChineseTitle
    || Boolean(existing.options?.videoDescription) !== effectiveDescription
  ));
  const now = utcNow();

  let phases = existing && !sourceChanged && !refreshIncomplete
    ? { ...existing.phases }
    : pendingPhases(effectiveBilingualAss);
  phases.normalized = { status: 'verified', cueCount: parsed.cues.length, at: now };
  if (!effectiveBilingualAss) phases.ass = { status: 'not-requested' };
  else if (!existing || sourceChanged || existing.options?.bilingualAss !== true) {
    phases.readable = { status: 'pending' };
    phases.ass = { status: 'pending' };
  }
  if (optionsChanged) phases.qa = { status: 'pending' };

  const job = {
    schemaVersion: JOB_SCHEMA_VERSION,
    id: jobId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    options: { bilingualAss: effectiveBilingualAss, chineseTitle: effectiveChineseTitle, videoDescription: effectiveDescription, subtitleLanguage: existing?.options?.subtitleLanguage ?? 'bilingual' },
    source: {
      originalPath: source,
      format: parsed.format,
      cueCount: parsed.cues.length,
      normalizedPath: 'source/source.en.srt',
      warnings: parsed.warnings,
      timelineWarnings: findTimelineIssues(parsed.cues),
    },
    phases,
  };

  await ensureDir(join(jobPath, 'source'));
  await ensureDir(join(jobPath, 'subtitles'));
  await ensureDir(join(jobPath, 'qa'));
  const refreshReason = existing ? 'The normalized source subtitles changed.' : '';
  if (existing && (sourceChanged || refreshIncomplete)) {
    await saveJob(jobPath, {
      ...job,
      phases: {
        ...pendingPhases(effectiveBilingualAss),
        normalized: { status: 'refreshing', at: now },
      },
    });
    await invalidateAiReview({ jobPath, job, reason: refreshReason });
  }
  await atomicWrite(normalizedPath, normalized);
  if (!existing || sourceChanged || refreshIncomplete) {
    const paths = jobArtifactPaths(jobPath);
    const currentCandidates = existing && await pathExists(paths.termCandidates) ? await readJson(paths.termCandidates) : null;
    const currentDecisions = existing && await pathExists(paths.termDecisions) ? await readJson(paths.termDecisions) : null;
    await atomicWriteJson(paths.termCandidates, resetTerminologyRecord(emptyTermCandidates(jobId), currentCandidates, 'previousCandidates', refreshReason));
    await atomicWriteJson(paths.termDecisions, resetTerminologyRecord(emptyTermDecisions(jobId), currentDecisions, 'previousDecisions', refreshReason));
    if (!existing) await invalidateAiReview({ jobPath, job, reason: refreshReason });
  } else if (optionsChanged) {
    await invalidateQaArtifacts({ jobPath, job, reason: 'Requested output options changed.' });
  }
  const titlePath = jobArtifactPaths(jobPath).title;
  if ((sourceChanged || refreshIncomplete) && await pathExists(titlePath)) {
    await atomicWrite(titlePath, 'Original: \nChinese: \n');
  } else if (effectiveChineseTitle && (!existing || !(await pathExists(titlePath)))) {
    await atomicWrite(titlePath, 'Original: \nChinese: \n');
  }
  const descriptionPath = jobArtifactPaths(jobPath).description;
  if (effectiveDescription && (!(await pathExists(descriptionPath)) || sourceChanged || refreshIncomplete)) {
    await atomicWrite(descriptionPath, '# 视频简介\n\n来源：\n作者：\n\n');
  }
  await saveJob(jobPath, job);
  return {
    jobPath,
    job,
    created: !existing,
    refreshed: sourceChanged || refreshIncomplete || optionsChanged,
    resumed: Boolean(existing && !sourceChanged && !refreshIncomplete && !optionsChanged),
  };
}

export function jobArtifactPaths(jobPath) {
  return Object.fromEntries(Object.entries(JOB_ARTIFACT_LAYOUT).map(([name, relativePath]) => [name, join(jobPath, relativePath)]));
}

export async function invalidateQaArtifacts({ jobPath, job, reason = '' }) {
  const paths = jobArtifactPaths(jobPath);
  await atomicWriteJson(paths.qa, {
    schemaVersion: 1,
    job: job.id,
    generatedAt: utcNow(),
    status: 'pending',
    passed: false,
    reason,
    errors: [],
    warnings: [],
  });
  await atomicWrite(paths.report, `# Subtitle Me QA\n\nStatus: PENDING\n\n${reason || 'Upstream artifacts changed. Run final QA again before delivery.'}\n`);
}

export async function invalidateAiReview({ jobPath, job, cueCount = job.source?.cueCount ?? 0, reason = '' }) {
  const paths = jobArtifactPaths(jobPath);
  await invalidateQaArtifacts({ jobPath, job, reason });
  let current = null;
  if (await pathExists(paths.aiReview)) {
    try {
      current = await readJson(paths.aiReview);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
    }
  }
  const previousReview = current?.status === 'passed' || current?.reviewedAt
    ? {
        status: current.status,
        reviewedAt: current.reviewedAt,
        coverage: current.coverage,
        batches: current.batches,
        issues: current.issues,
        notes: current.notes,
        invalidatedAt: utcNow(),
        reason,
      }
    : current?.previousReview;
  const scaffold = {
    schemaVersion: 1,
    job: job.id,
    status: 'pending',
    reviewedAt: null,
    coverage: [],
    issues: [],
    notes: '',
    instructions: `Review all ${cueCount} cues independently. Check source fidelity, terminology decisions, names, numbers, and natural Chinese. Set status to passed, add complete cue ranges, and record every issue with resolution evidence.${reason ? ` Reset reason: ${reason}` : ''}`,
    ...(previousReview ? { previousReview } : {}),
  };
  await atomicWriteJson(paths.aiReview, scaffold);
  return scaffold;
}
