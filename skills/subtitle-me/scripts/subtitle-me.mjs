#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBilingualAss, ffmpegAvailable, renderAssPreview } from './lib/ass.mjs';
import {
  atomicWrite,
  booleanOption,
  parseCliArgs,
  pathExists,
  readJson,
  readUtf8,
  requiredOption,
  UserError,
  utcNow,
} from './lib/common.mjs';
import { applyDecisions, initializeGlossary, lintGlossary, lintTermFile } from './lib/glossary.mjs';
import {
  initializeJob,
  invalidateAiReview,
  invalidateQaArtifacts,
  jobArtifactPaths,
  loadJob,
  resolveStateRootFor,
  saveJob,
} from './lib/jobs.mjs';
import { runQa, createAiReviewScaffold, isTerminologyIssueCode } from './lib/qa.mjs';
import { createReadableLayers } from './lib/readable.mjs';
import { parseSrt, writeSrt } from './lib/subtitles.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(SCRIPT_DIR, '..');
const VERSION = (await readUtf8(join(SCRIPT_DIR, '..', 'VERSION'))).trim();

function terminalData(value) {
  return String(value).replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, (character) => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    const code = character.codePointAt(0);
    return code <= 0xFF ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

function terminalTemplate(strings, values) {
  return strings.reduce((output, part, index) => output + part + (index < values.length ? terminalData(values[index]) : ''), '');
}

function writeOutput(strings, ...values) {
  process.stdout.write(terminalTemplate(strings, values));
}

function writeError(strings, ...values) {
  process.stderr.write(terminalTemplate(strings, values));
}

const HELP = `subtitle-me ${VERSION}\n\nTranslate timed English subtitles into reviewed Simplified Chinese.\n\nCommands:\n  doctor [--ass-preview]\n  init --input <captions.srt|vtt|json3|ass> [--project <dir>] [--job <id>] [--ass yes|no] [--title yes|no] [--description yes|no]\n  glossary lint [--project <dir>]\n  glossary apply --job <job-dir> [--only <English term>]\n  readable --job <job-dir>\n  review scaffold --job <job-dir>\n  ass build --job <job-dir> [--font <family>] [--language bilingual|zh|en]\n  ass preview --job <job-dir> [--video <file>] [--at <seconds>] [--output <preview.png>]\n  qa --job <job-dir>\n  status --job <job-dir>\n\nThe visible project workspace is always <project>/subtitle-localizer/.`;

function printHelp() {
  process.stdout.write(`${HELP}\n`);
}

function stateRootFromJob(jobPath) {
  return dirname(dirname(jobPath));
}

function assertProjectOutsideSkill(projectRoot) {
  const projectWithinSkill = relative(SKILL_ROOT, projectRoot);
  if (projectWithinSkill === '' || (!projectWithinSkill.startsWith('..') && !isAbsolute(projectWithinSkill))) {
    throw new UserError('Choose a project directory outside the installed subtitle-me skill. Project state must not be created inside the skill package.');
  }
}

async function loadProjectJobs(stateRoot) {
  const jobsRoot = join(stateRoot, 'jobs');
  if (!(await pathExists(jobsRoot))) return [];
  const entries = await readdir(jobsRoot, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isDirectory()) continue;
    if (!(await pathExists(join(jobsRoot, entry.name, 'job.json')))) continue;
    jobs.push(await loadJob(join(jobsRoot, entry.name)));
  }
  return jobs;
}

async function invalidateTerminologyConsumers(jobs, reason) {
  for (const loaded of jobs) {
    await invalidateQaArtifacts({ jobPath: loaded.path, job: loaded.job, reason });
    await saveJob(loaded.path, {
      ...loaded.job,
      phases: {
        ...loaded.job.phases,
        terminology: { status: 'pending' },
        aiReview: { status: 'pending' },
        readable: { status: 'pending' },
        ass: loaded.job.options.bilingualAss ? { status: 'pending' } : { status: 'not-requested' },
        qa: { status: 'pending' },
      },
    });
    await invalidateAiReview({ jobPath: loaded.path, job: loaded.job, reason });
  }
}

const COMMAND_SCHEMAS = new Map([
  ['doctor', { values: [], booleans: ['ass-preview', 'help'] }],
  ['init', { values: ['input', 'project', 'job'], booleans: ['ass', 'title', 'description', 'help'] }],
  ['glossary lint', { values: ['project'], booleans: ['help'] }],
  ['glossary apply', { values: ['job', 'only'], booleans: ['help'] }],
  ['readable', { values: ['job'], booleans: ['help'] }],
  ['review scaffold', { values: ['job'], booleans: ['help'] }],
  ['ass build', { values: ['job', 'font', 'language'], booleans: ['help'] }],
  ['ass preview', { values: ['job', 'video', 'at', 'output'], booleans: ['help'] }],
  ['qa', { values: ['job'], booleans: ['help'] }],
  ['status', { values: ['job'], booleans: ['help'] }],
  ['help', { values: [], booleans: [] }],
]);

function validateCommandArgs(positionals, options) {
  const route = positionals.slice(0, ['glossary', 'review', 'ass'].includes(positionals[0]) ? 2 : 1).join(' ');
  const schema = COMMAND_SCHEMAS.get(route);
  if (!schema) throw new UserError(`Unknown command: ${positionals.join(' ') || '(none)'}\n\n${HELP}`);
  const expectedPositionals = route.split(' ').length;
  if (positionals.length !== expectedPositionals) throw new UserError(`Unexpected positional argument: ${positionals.slice(expectedPositionals).join(' ')}`);
  const allowed = new Set([...schema.values, ...schema.booleans]);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw new UserError(`Unknown option --${key} for ${route}`);
    if (schema.values.includes(key) && (value === true || value === '')) throw new UserError(`Missing value for --${key}`);
  }
}

async function commandDoctor(options) {
  const major = Number(process.versions.node.split('.')[0]);
  const previewRequested = booleanOption(options, 'ass-preview', false);
  const report = {
    version: VERSION,
    node: process.versions.node,
    nodeSupported: major >= 20,
    platform: process.platform,
    formats: ['SRT', 'WebVTT', 'YouTube JSON3', 'ASS dialogue extraction'],
    ffmpeg: previewRequested ? (ffmpegAvailable() ? 'available' : 'missing') : 'not checked (only needed for ASS preview)',
  };
  for (const [key, value] of Object.entries(report)) writeOutput`${key}: ${Array.isArray(value) ? value.join(', ') : value}\n`;
  if (!report.nodeSupported) throw new UserError('Node.js 20 or newer is required');
  if (previewRequested && report.ffmpeg === 'missing') {
    throw new UserError('FFMPEG_REQUIRED: FFmpeg is optional and only needed for ASS preview.', 2);
  }
}

async function commandInit(options) {
  const inputPath = requiredOption(options, 'input');
  const stateRoot = await resolveStateRootFor(String(options.project ?? process.cwd()));
  const projectRoot = dirname(stateRoot);
  assertProjectOutsideSkill(projectRoot);
  const result = await initializeJob({
    projectRoot,
    inputPath,
    requestedId: options.job ? String(options.job) : undefined,
    bilingualAss: options.ass === undefined ? undefined : booleanOption(options, 'ass', false),
    videoDescription: options.description === undefined ? undefined : booleanOption(options, 'description', false),
    chineseTitle: options.title === undefined ? undefined : booleanOption(options, 'title', false),
  });
  writeOutput`Subtitle Me job ${result.resumed ? 'resumed' : result.refreshed ? 'refreshed' : 'created'}\n`;
  writeOutput`job: ${result.jobPath}\n`;
  writeOutput`source cues: ${result.job.source.cueCount}\n`;
  writeOutput`source format: ${result.job.source.format}\n`;
  writeOutput`bilingual ASS: ${result.job.options.bilingualAss ? 'yes' : 'no'}\n`;
  writeOutput`Chinese title: ${result.job.options.chineseTitle ? 'yes' : 'no'}\n`;
  if (result.job.source.warnings.length > 0) {
    for (const warning of result.job.source.warnings) writeOutput`warning: ${warning}\n`;
  }
  writeOutput`next: complete qa/term-candidates.json and qa/term-decisions.json, then translate subtitles/semantic.zh-Hans.srt\n`;
}

async function commandGlossary(positionals, options) {
  const action = positionals[1];
  if (action === 'lint') {
    const stateRoot = await resolveStateRootFor(String(options.project ?? process.cwd()));
    assertProjectOutsideSkill(dirname(stateRoot));
    const { glossaryPath, glossary } = await initializeGlossary(stateRoot);
    const report = lintGlossary(glossary);
    writeOutput`glossary: ${glossaryPath}\nrevision: ${glossary.revision}\nterms: ${glossary.terms.length}\npassed: ${report.passed}\n`;
    report.warnings.forEach((warning) => writeOutput`warning: ${warning}\n`);
    if (!report.passed) throw new UserError(report.errors.join('\n'));
    return;
  }
  if (action === 'apply') {
    const { path: jobPath, job } = await loadJob(requiredOption(options, 'job'));
    const paths = jobArtifactPaths(jobPath);
    const stateRoot = stateRootFromJob(jobPath);
    const glossaryPath = join(stateRoot, 'glossary.json');
    const only = options.only === undefined ? [] : [String(options.only)];
    const result = await applyDecisions({
      glossaryPath,
      decisionsPath: paths.termDecisions,
      only,
      expectedJob: job.id,
      beforeApply: async () => invalidateTerminologyConsumers([{ path: jobPath, job }], 'Terminology decisions are being applied.'),
      beforeProjectChange: async () => invalidateTerminologyConsumers(
        (await loadProjectJobs(stateRoot)).filter((loaded) => resolve(loaded.path) !== resolve(jobPath)),
        'The project glossary is changing.',
      ),
    });
    const current = await loadJob(jobPath);
    await saveJob(current.path, {
      ...current.job,
      phases: {
        ...current.job.phases,
        terminology: { status: 'applied', at: utcNow() },
        aiReview: { status: 'pending' },
        qa: { status: 'pending' },
      },
    });
    writeOutput`changed: ${result.changed}\nrevision: ${result.revision}\nchanges: ${result.changes.length}\n`;
    return;
  }
  throw new UserError('Use glossary lint or glossary apply');
}

async function commandReadable(options) {
  const { path: jobPath, job } = await loadJob(requiredOption(options, 'job'));
  const paths = jobArtifactPaths(jobPath);
  const reason = 'Readable subtitles are being regenerated from the semantic translation.';
  await invalidateQaArtifacts({ jobPath, job, reason });
  await saveJob(jobPath, {
    ...job,
    phases: {
      ...job.phases,
      readable: { status: 'pending' },
      aiReview: { status: 'pending' },
      ass: job.options.bilingualAss ? { status: 'pending' } : { status: 'not-requested' },
      qa: { status: 'pending' },
    },
  });
  await invalidateAiReview({ jobPath, job, reason });
  if (!(await pathExists(paths.semanticZh))) throw new UserError(`Translation is missing: ${paths.semanticZh}`);
  const glossary = await readJson(join(stateRootFromJob(jobPath), 'glossary.json'));
  const decisions = await readJson(paths.termDecisions);
  const decisionLint = lintTermFile(decisions, { decisions: true });
  if (!decisionLint.passed) throw new UserError(`Invalid terminology decisions:\n${decisionLint.errors.join('\n')}`);
  const result = createReadableLayers({
    sourceCues: parseSrt(await readUtf8(paths.source)),
    semanticZhCues: parseSrt(await readUtf8(paths.semanticZh)),
    glossaryTerms: glossary.terms,
    localDecisions: decisions.terms,
    bilingualAss: job.options.bilingualAss,
  });
  await atomicWrite(paths.readableZh, writeSrt(result.readableZh));
  await atomicWrite(paths.readableEn, writeSrt(result.readableEn));
  const next = {
    ...job,
    phases: {
      ...job.phases,
      translation: { status: 'present', at: utcNow() },
      readable: {
        status: 'generated',
        warnings: result.warnings,
        at: utcNow(),
      },
      aiReview: { status: 'pending', at: utcNow() },
      ass: job.options.bilingualAss ? { status: 'pending' } : { status: 'not-requested' },
      qa: { status: 'pending', at: utcNow() },
    },
  };
  await saveJob(jobPath, next);
  writeOutput`readable Chinese: ${paths.readableZh}\nreadable English: ${paths.readableEn}\ncues: ${result.readableZh.length}\nwarnings: ${result.warnings.length}\n`;
}

async function commandReview(positionals, options) {
  if (positionals[1] !== 'scaffold') throw new UserError('Use review scaffold');
  const { path: jobPath, job } = await loadJob(requiredOption(options, 'job'));
  const glossaryPath = join(stateRootFromJob(jobPath), 'glossary.json');
  await saveJob(jobPath, {
    ...job,
    phases: {
      ...job.phases,
      aiReview: { status: 'pending', at: utcNow() },
      qa: { status: 'pending', at: utcNow() },
    },
  });
  const scaffold = await createAiReviewScaffold({ jobPath, glossaryPath });
  writeOutput`AI review scaffold: ${jobArtifactPaths(jobPath).aiReview}\nsource cues: ${parseSrt(await readUtf8(jobArtifactPaths(jobPath).source)).length}\nstatus: ${scaffold.status}\n`;
}

async function commandAss(positionals, options) {
  const action = positionals[1];
  const { path: jobPath, job } = await loadJob(requiredOption(options, 'job'));
  const paths = jobArtifactPaths(jobPath);
  if (action === 'build') {
    if (!job.options.bilingualAss) throw new UserError('This job did not request bilingual ASS. Re-run init with --ass yes to change the option.');
    await invalidateQaArtifacts({ jobPath, job, reason: 'The bilingual ASS is being regenerated.' });
    await saveJob(jobPath, {
      ...job,
      phases: {
        ...job.phases,
        ass: { status: 'pending' },
        qa: { status: 'pending' },
      },
    });
    for (const required of [paths.readableZh, paths.readableEn]) {
      if (!(await pathExists(required))) throw new UserError(`Run readable first. Missing ${required}`);
    }
    const [readableZh, readableEn] = await Promise.all([
      readUtf8(paths.readableZh),
      readUtf8(paths.readableEn),
    ]);
    const ass = buildBilingualAss({
      language: String(options.language ?? job.options.subtitleLanguage ?? 'bilingual'),
      zhCues: parseSrt(readableZh),
      enCues: parseSrt(readableEn),
      fontName: String(options.font ?? 'Noto Sans CJK SC'),
    });
    await atomicWrite(paths.ass, ass);
    job.options.subtitleLanguage = String(options.language ?? job.options.subtitleLanguage ?? 'bilingual');
    await saveJob(jobPath, {
      ...job,
      phases: {
        ...job.phases,
        ass: { status: 'generated', at: utcNow() },
        qa: { status: 'pending', at: utcNow() },
      },
    });
    writeOutput`bilingual ASS: ${paths.ass}\nFFmpeg: not required for generation\n`;
    return;
  }
  if (action === 'preview') {
    if (!(await pathExists(paths.ass))) throw new UserError(`ASS file is missing: ${paths.ass}`);
    const outputPath = resolve(String(options.output ?? join(jobPath, 'preview.png')));
    const result = await renderAssPreview({
      assPath: paths.ass,
      outputPath,
      videoPath: options.video ? resolve(String(options.video)) : undefined,
      at: Number(options.at ?? 5),
    });
    writeOutput`preview: ${result.outputPath}\n`;
    return;
  }
  throw new UserError('Use ass build or ass preview');
}

async function commandQa(options) {
  const { path: jobPath, job } = await loadJob(requiredOption(options, 'job'));
  const glossaryPath = join(stateRootFromJob(jobPath), 'glossary.json');
  await invalidateQaArtifacts({ jobPath, job, reason: 'Final QA is running. Previous results are no longer current.' });
  await saveJob(jobPath, {
    ...job,
    phases: {
      ...job.phases,
      qa: { status: 'pending', at: utcNow() },
    },
  });
  if (job.phases.readable?.status !== 'generated') {
    throw new UserError('Readable subtitles are not current. Run readable before final QA.');
  }
  if (job.options.bilingualAss && job.phases.ass?.status !== 'generated') {
    throw new UserError('Bilingual ASS is not current. Run ass build before final QA.');
  }
  const report = await runQa({ jobPath, job, glossaryPath });
  await saveJob(jobPath, {
    ...job,
    phases: {
      ...job.phases,
      terminology: { status: report.errors.some((item) => isTerminologyIssueCode(item.code)) ? 'failed' : 'verified', at: utcNow() },
      aiReview: { status: report.errors.some((item) => item.code.startsWith('ai_review')) ? 'failed' : 'verified', at: utcNow() },
      qa: { status: report.passed ? 'passed' : 'failed', errors: report.errors.length, warnings: report.warnings.length, at: utcNow() },
    },
  });
  writeOutput`QA: ${report.passed ? 'PASS' : 'FAIL'}\nerrors: ${report.errors.length}\nwarnings: ${report.warnings.length}\nreport: ${jobArtifactPaths(jobPath).report}\n`;
  if (!report.passed) throw new UserError('Final QA did not pass. Review qa/qa.json and report.md.');
}

async function commandStatus(options) {
  const loaded = await loadJob(requiredOption(options, 'job'));
  const { job } = loaded;
  const paths = jobArtifactPaths(loaded.path);
  writeOutput`job: ${loaded.path}\n`;
  for (const [phase, state] of Object.entries(job.phases)) writeOutput`${phase}: ${state.status}\n`;
  writeOutput`artifacts:\n`;
  for (const [name, path] of Object.entries(paths)) {
    if (await pathExists(path)) writeOutput`  ${name}: ${path}\n`;
  }
}

async function main() {
  const { positionals, options } = parseCliArgs(process.argv.slice(2));
  const command = positionals[0];
  if (!command) {
    printHelp();
    return;
  }
  validateCommandArgs(positionals, options);
  if (command === 'help' || options.help) {
    printHelp();
    return;
  }
  if (command === 'doctor') await commandDoctor(options);
  else if (command === 'init') await commandInit(options);
  else if (command === 'glossary') await commandGlossary(positionals, options);
  else if (command === 'readable') await commandReadable(options);
  else if (command === 'review') await commandReview(positionals, options);
  else if (command === 'ass') await commandAss(positionals, options);
  else if (command === 'qa') await commandQa(options);
  else if (command === 'status') await commandStatus(options);
  else throw new UserError(`Unknown command: ${command}\n\n${HELP}`);
}

try {
  await main();
} catch (error) {
  if (error instanceof UserError) {
    writeError`subtitle-me: ${error.message}\n`;
    process.exitCode = error.exitCode;
  } else {
    writeError`subtitle-me: unexpected error\n${error?.stack ?? error}\n`;
    process.exitCode = 1;
  }
}
