import { basename, dirname, join, resolve } from 'node:path';
import {
  assertNoSymlinkPath,
  appendJsonLine,
  atomicWrite,
  atomicWriteJson,
  defaultCaseSensitive,
  normalizeKey,
  normalizedSourceForm,
  pathExists,
  readJson,
  sourceFormBucket,
  sourceFormsOverlap,
  UserError,
  utcNow,
} from './common.mjs';

export const GLOSSARY_SCHEMA_VERSION = 1;
export const DECISIONS_SCHEMA_VERSION = 1;

export function emptyGlossary() {
  return {
    schemaVersion: GLOSSARY_SCHEMA_VERSION,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    revision: 0,
    updatedAt: null,
    terms: [],
  };
}

export function emptyTermCandidates(jobId) {
  return {
    schemaVersion: 1,
    job: jobId,
    completed: false,
    updatedAt: null,
    terms: [],
  };
}

export function emptyTermDecisions(jobId) {
  return {
    schemaVersion: DECISIONS_SCHEMA_VERSION,
    job: jobId,
    completed: false,
    updatedAt: null,
    terms: [],
  };
}

function termId(english) {
  const key = normalizeKey(english);
  return key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'term';
}

function uniqueTermId(preferred, terms) {
  const used = new Set(terms.map((term) => term.id));
  if (!used.has(preferred)) return preferred;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${preferred}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function normalizeAliases(value, english, caseSensitive) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new UserError(`aliases for ${english} must be an array`);
  if (value.length > 32) throw new UserError(`aliases for ${english} may contain at most 32 values`);
  const result = [];
  const seen = new Map();
  seen.set(sourceFormBucket(english), [english]);
  for (const alias of value) {
    if (typeof alias !== 'string' || !alias.trim()) throw new UserError(`aliases for ${english} must contain non-empty strings`);
    if (alias.trim().length > 256) throw new UserError(`aliases for ${english} must be at most 256 characters`);
    const normalized = alias.trim().replace(/\s+/g, ' ');
    const bucket = sourceFormBucket(normalized);
    const equivalent = (seen.get(bucket) ?? []).some((existing) => sourceFormsOverlap(existing, caseSensitive, normalized, caseSensitive));
    if (!equivalent) {
      if (!seen.has(bucket)) seen.set(bucket, []);
      seen.get(bucket).push(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function normalizedTerm(input, { decision = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('Each terminology entry must be an object');
  const en = String(input.en ?? '').trim().replace(/\s+/g, ' ');
  if (!en) throw new UserError('Every terminology entry requires en');
  if (en.length > 256) throw new UserError('Terminology en must be at most 256 characters');
  const approvalStatus = String(input.approvalStatus ?? (decision ? '' : 'approved'));
  const syncScope = String(input.syncScope ?? (decision ? '' : 'project'));
  const allowedApprovals = decision ? ['approved', 'review-required', 'rejected'] : ['approved'];
  if (!allowedApprovals.includes(approvalStatus)) {
    throw new UserError(`${en}: approvalStatus must be ${allowedApprovals.join(', ')}`);
  }
  if (!['project', 'job'].includes(syncScope)) throw new UserError(`${en}: syncScope must be project or job`);
  const zhHans = String(input.zhHans ?? '').trim().replace(/\s+/g, ' ');
  if (zhHans.length > 256) throw new UserError(`${en}: zhHans must be at most 256 characters`);
  if (approvalStatus === 'approved' && !zhHans) throw new UserError(`${en}: approved terminology requires zhHans`);
  if (approvalStatus === 'review-required' && !decision) throw new UserError(`${en}: unresolved terminology cannot enter glossary.json`);
  if (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean') throw new UserError(`${en}: caseSensitive must be true or false`);
  const caseSensitive = input.caseSensitive === undefined ? defaultCaseSensitive(en) : Boolean(input.caseSensitive);
  return {
    id: String(input.id ?? termId(en)),
    en,
    aliases: normalizeAliases(input.aliases, en, caseSensitive),
    caseSensitive,
    zhHans,
    category: String(input.category ?? 'term').trim() || 'term',
    approvalStatus,
    syncScope,
    status: String(input.status ?? (decision ? 'ai-proposed' : 'approved')).trim(),
    rationale: String(input.rationale ?? '').trim(),
  };
}

function formRegistry() {
  return new Map();
}

function registerForm(registry, value, caseSensitive, index) {
  const exact = normalizedSourceForm(value);
  const bucket = sourceFormBucket(exact);
  const entries = registry.get(bucket) ?? [];
  const conflict = entries.find((entry) => sourceFormsOverlap(exact, caseSensitive, entry.exact, entry.caseSensitive));
  if (conflict) return conflict.index;
  entries.push({ exact, caseSensitive, index });
  registry.set(bucket, entries);
  return null;
}

export function lintGlossary(glossary) {
  const errors = [];
  const warnings = [];
  if (!glossary || typeof glossary !== 'object' || Array.isArray(glossary)) errors.push('glossary must be an object');
  if (glossary?.schemaVersion !== GLOSSARY_SCHEMA_VERSION) errors.push(`schemaVersion must be ${GLOSSARY_SCHEMA_VERSION}`);
  if (glossary?.sourceLanguage !== 'en') errors.push('sourceLanguage must be en');
  if (glossary?.targetLanguage !== 'zh-Hans') errors.push('targetLanguage must be zh-Hans');
  if (!Number.isInteger(glossary?.revision) || glossary.revision < 0) errors.push('revision must be a non-negative integer');
  if (!Array.isArray(glossary?.terms)) errors.push('terms must be an array');
  if (Array.isArray(glossary?.terms) && glossary.terms.length > 2000) errors.push('terms may contain at most 2000 entries');
  const keys = formRegistry();
  const ids = new Set();
  for (const [index, rawTerm] of (Array.isArray(glossary?.terms) ? glossary.terms : []).entries()) {
    try {
      const term = normalizedTerm(rawTerm);
      if (ids.has(term.id)) errors.push(`terms[${index}] duplicates id ${term.id}`);
      ids.add(term.id);
      for (const value of [term.en, ...term.aliases]) {
        const conflict = registerForm(keys, value, term.caseSensitive, index);
        if (conflict !== null) errors.push(`terms[${index}] duplicates ${value} from terms[${conflict}]`);
      }
      if (!term.rationale) warnings.push(`terms[${index}] ${term.en} has no rationale`);
    } catch (error) {
      errors.push(`terms[${index}]: ${error.message}`);
    }
  }
  return { passed: errors.length === 0, errors, warnings };
}

export function lintTermFile(file, { decisions = false } = {}) {
  const errors = [];
  if (!file || typeof file !== 'object' || Array.isArray(file)) return { passed: false, errors: ['file must be an object'] };
  if (file.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof file.completed !== 'boolean') errors.push('completed must be true or false');
  if (!Array.isArray(file.terms)) errors.push('terms must be an array');
  if (Array.isArray(file.terms) && file.terms.length > 2000) errors.push('terms may contain at most 2000 entries');
  const keys = formRegistry();
  for (const [index, term] of (Array.isArray(file.terms) ? file.terms : []).entries()) {
    try {
      const normalized = decisions
        ? normalizedTerm(term, { decision: true })
        : normalizedCandidate(term);
      for (const value of [normalized.en, ...(normalized.aliases ?? [])]) {
        const conflict = registerForm(keys, value, normalized.caseSensitive, index);
        if (conflict !== null) errors.push(`terms[${index}] duplicates ${value} from terms[${conflict}]`);
      }
    } catch (error) {
      errors.push(`terms[${index}]: ${error.message}`);
    }
  }
  return { passed: errors.length === 0, errors };
}

export function normalizedCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('Each candidate must be an object');
  const en = String(input.en ?? '').trim().replace(/\s+/g, ' ');
  if (!en) throw new UserError('Every candidate requires en');
  if (en.length > 256) throw new UserError('Candidate en must be at most 256 characters');
  if (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean') throw new UserError(`${en}: caseSensitive must be true or false`);
  const cueIndexes = Array.isArray(input.cueIndexes)
    ? [...new Set(input.cueIndexes.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b)
    : [];
  if (cueIndexes.length === 0) throw new UserError(`${en}: cueIndexes must include at least one cue`);
  const caseSensitive = input.caseSensitive === undefined ? defaultCaseSensitive(en) : Boolean(input.caseSensitive);
  return {
    en,
    aliases: normalizeAliases(input.aliases, en, caseSensitive),
    caseSensitive,
    category: String(input.category ?? 'term').trim() || 'term',
    cueIndexes,
    reason: String(input.reason ?? '').trim(),
  };
}

export function renderGlossaryMarkdown(glossary) {
  const lines = [
    '# Project Glossary',
    '',
    `Source: English  `,
    `Target: Simplified Chinese  `,
    `Revision: ${glossary.revision}`,
    '',
    '> Generated from `glossary.json`. Make formal changes through a terminology decision file.',
    '',
  ];
  if (glossary.terms.length === 0) {
    lines.push('No approved project terms yet.', '');
    return lines.join('\n');
  }
  lines.push('| English | Simplified Chinese | Category | Aliases | Rationale |', '| --- | --- | --- | --- | --- |');
  for (const term of glossary.terms) {
    const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
    lines.push(`| ${cell(term.en)} | ${cell(term.zhHans)} | ${cell(term.category)} | ${cell(term.aliases.join(', '))} | ${cell(term.rationale)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function initializeGlossary(stateRoot) {
  const glossaryPath = join(stateRoot, 'glossary.json');
  const markdownPath = join(stateRoot, 'glossary.md');
  const journalPath = join(stateRoot, 'glossary.changes.jsonl');
  for (const target of [stateRoot, glossaryPath, markdownPath, journalPath]) {
    await assertNoSymlinkPath(dirname(stateRoot), target);
  }
  if (!(await pathExists(glossaryPath))) await atomicWriteJson(glossaryPath, emptyGlossary());
  const glossary = await readJson(glossaryPath);
  const lint = lintGlossary(glossary);
  if (!lint.passed) throw new UserError(`Invalid project glossary:\n${lint.errors.join('\n')}`);
  await atomicWrite(markdownPath, renderGlossaryMarkdown(glossary));
  if (!(await pathExists(journalPath))) await atomicWrite(journalPath, '');
  return { glossaryPath, markdownPath, journalPath, glossary };
}

export async function applyDecisions({ glossaryPath, decisionsPath, only = [], expectedJob, beforeApply, beforeProjectChange }) {
  const stateRoot = dirname(resolve(glossaryPath));
  const { markdownPath, journalPath } = await initializeGlossary(stateRoot);
  const glossary = await readJson(glossaryPath);
  const decisions = await readJson(decisionsPath);
  if (expectedJob !== undefined && decisions.job !== expectedJob) throw new UserError('Terminology decisions belong to a different job.');
  const glossaryLint = lintGlossary(glossary);
  const decisionsLint = lintTermFile(decisions, { decisions: true });
  if (!glossaryLint.passed) throw new UserError(`Invalid glossary:\n${glossaryLint.errors.join('\n')}`);
  if (!decisionsLint.passed) throw new UserError(`Invalid decisions:\n${decisionsLint.errors.join('\n')}`);
  if (!decisions.completed) throw new UserError('Terminology decisions are not marked completed');
  const unresolved = decisions.terms.filter((item) => item.approvalStatus === 'review-required');
  if (unresolved.length > 0) throw new UserError(`Resolve terminology before applying: ${unresolved.map((item) => item.en).join(', ')}`);
  const normalizedDecisions = decisions.terms.map((raw) => ({ raw, term: normalizedTerm(raw, { decision: true }) }));
  const selected = only.length > 0 ? only.map((value) => String(value).normalize('NFKC').trim().replace(/\s+/g, ' ')) : null;
  const isSelected = ({ term }) => !selected || selected.some((value) => term.caseSensitive
    ? value === term.en
    : normalizeKey(value) === normalizeKey(term.en));
  if (selected) {
    const unknown = selected.filter((value) => !normalizedDecisions.some(({ term }) => term.caseSensitive
      ? value === term.en
      : normalizeKey(value) === normalizeKey(term.en)));
    if (unknown.length > 0) throw new UserError(`Unknown --only selection: ${unknown.join(', ')}`);
  }
  const selectedDecisions = normalizedDecisions.filter(isSelected);
  const projectScopedSelected = selectedDecisions.some(({ term }) => term.approvalStatus === 'approved' && term.syncScope === 'project');
  const terms = glossary.terms.map((item) => normalizedTerm(item));
  const changes = [];
  for (const { raw, term: decision } of selectedDecisions) {
    if (decision.approvalStatus !== 'approved' || decision.syncScope !== 'project') continue;
    const index = terms.findIndex((item) => sourceFormsOverlap(item.en, item.caseSensitive, decision.en, decision.caseSensitive));
    const next = { ...decision, approvalStatus: 'approved', syncScope: 'project' };
    if (index >= 0 && !raw.id) next.id = terms[index].id;
    if (index < 0) {
      next.id = uniqueTermId(next.id, terms);
      terms.push(next);
      changes.push({ action: 'add', en: next.en, before: null, after: next });
    } else if (JSON.stringify(terms[index]) !== JSON.stringify(next)) {
      const before = terms[index];
      terms[index] = next;
      changes.push({ action: 'update', en: next.en, before, after: next });
    }
  }
  if (changes.length === 0) {
    if (beforeApply) await beforeApply();
    return { changed: false, revision: glossary.revision, changes: [], projectScopedSelected };
  }
  terms.sort((a, b) => normalizeKey(a.en).localeCompare(normalizeKey(b.en), 'en') || a.en.localeCompare(b.en, 'en'));
  const updatedAt = utcNow();
  const nextGlossary = { ...glossary, revision: glossary.revision + 1, updatedAt, terms };
  const finalLint = lintGlossary(nextGlossary);
  if (!finalLint.passed) throw new UserError(`Refusing to write invalid glossary:\n${finalLint.errors.join('\n')}`);
  if (beforeApply) await beforeApply();
  if (beforeProjectChange) await beforeProjectChange();
  const journalEvent = {
    schemaVersion: 1,
    timestamp: updatedAt,
    project: decisions.job ?? basename(decisionsPath),
    revisionBefore: glossary.revision,
    revisionAfter: nextGlossary.revision,
    decisionsFile: basename(decisionsPath),
    changes,
  };
  await atomicWriteJson(glossaryPath, nextGlossary);
  await atomicWrite(markdownPath, renderGlossaryMarkdown(nextGlossary));
  await appendJsonLine(journalPath, journalEvent);
  return { changed: true, revision: nextGlossary.revision, changes, projectScopedSelected };
}

export function glossaryAcceptedSourceForms(glossary) {
  return glossary.terms.flatMap((term) => [term.en, ...(term.aliases ?? [])]);
}
