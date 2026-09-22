import { reviewContext, reviewBatches, sameReviewInput } from './review-context.mjs';
import { join } from 'node:path';
import {
  atomicWrite,
  atomicWriteJson,
  defaultCaseSensitive,
  fileSize,
  normalizedSourceForm,
  pathExists,
  readJson,
  readUtf8,
  sourceFormBucket,
  sourceFormCovers,
  sourceTermPattern,
  UserError,
  utcNow,
} from './common.mjs';
import { lintGlossary, lintTermFile, normalizedCandidate } from './glossary.mjs';
import {
  cueTextForComparison,
  displayUnits,
  findTimelineIssues,
  normalizeSubtitleText,
  parseAss,
  parseSrt,
} from './subtitles.mjs';
import { buildBilingualAss } from './ass.mjs';
import { invalidateAiReview, jobArtifactPaths } from './jobs.mjs';

const MAX_QA_ISSUES = 1000;

function addIssue(collection, severity, code, message, cue = null, details = {}) {
  if (collection.length >= MAX_QA_ISSUES) {
    if (!collection.some((item) => item.code === 'issue_limit_reached')) {
      collection.push({
        severity: 'error',
        code: 'issue_limit_reached',
        message: `QA stopped recording individual findings after ${MAX_QA_ISSUES} issues. Fix structural errors before retrying.`,
      });
    }
    return;
  }
  collection.push({ severity, code, message, ...(cue === null ? {} : { cue }), ...details });
}

function parseJsonSnapshot(snapshot, path) {
  try {
    return JSON.parse(snapshot.text);
  } catch (error) {
    throw new UserError(`Invalid JSON in ${path}: ${error.message}`);
  }
}

function sameTime(a, b) {
  return Math.abs(a - b) <= 0.002;
}

function normalizedNumbers(text) {
  return (String(text).match(/\d+(?:[.,]\d+)*%?/g) ?? []).map((value) => value.replaceAll(',', '')).sort();
}

export function containsSourceTerm(text, value, caseSensitive = defaultCaseSensitive(value)) {
  return sourceTermPattern(value, caseSensitive).test(String(text).normalize('NFKC'));
}

function hasUnshadowedSourceTerm(text, projectEntry, overrides) {
  const normalizedText = String(text).normalize('NFKC');
  for (const projectForm of projectEntry.forms) {
    const pattern = sourceTermPattern(projectForm, projectEntry.caseSensitive);
    let match;
    while ((match = pattern.exec(normalizedText)) !== null) {
      const exact = normalizedSourceForm(match[0].slice(match[1].length));
      const candidates = overrides.get(sourceFormBucket(exact)) ?? [];
      const shadowed = candidates.some((candidate) => sourceFormCovers(
        candidate.form,
        candidate.caseSensitive,
        exact,
        true,
      ));
      if (!shadowed) return true;
    }
  }
  return false;
}

function sourceCueIndex(sourceCues) {
  const byToken = new Map();
  sourceCues.forEach((cue, index) => {
    const tokens = new Set((cue.text.normalize('NFKC').match(/[\p{Letter}\p{Number}]+/gu) ?? []).map(sourceFormBucket));
    for (const token of tokens) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(index);
    }
  });
  return byToken;
}

function candidateCueIndexes(form, cueIndex, allIndexes) {
  const normalized = normalizedSourceForm(form);
  const tokens = [...new Set((normalized.match(/[\p{Letter}\p{Number}]+/gu) ?? []).map(sourceFormBucket))];
  if (tokens.length === 0) return allIndexes;
  let rarest = null;
  for (const token of tokens) {
    const indexes = cueIndex.get(token) ?? [];
    if (rarest === null || indexes.length < rarest.length) rarest = indexes;
    if (rarest.length === 0) break;
  }
  return rarest ?? [];
}

function reviewCoverageIsComplete(coverage, cueCount) {
  const seen = new Set();
  for (const item of Array.isArray(coverage) ? coverage : []) {
    const start = Number(item.cueStart);
    const end = Number(item.cueEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > cueCount) continue;
    for (let cue = start; cue <= end; cue += 1) seen.add(cue);
  }
  return seen.size === cueCount;
}

export async function createAiReviewScaffold({ jobPath, glossaryPath }) {
  const paths = jobArtifactPaths(jobPath);
  const job = await readJson(join(jobPath, 'job.json'));
  const scaffold = await invalidateAiReview({
    jobPath,
    job,
    reason: 'AI review scaffold requested. Complete the new review before final QA.',
  });
  for (const required of [paths.source, paths.semanticZh, paths.termCandidates, paths.termDecisions, glossaryPath]) {
    if (!(await pathExists(required))) throw new UserError(`Create ${required} before scaffolding AI review`);
  }
  const previous = scaffold.previousReview;
  const reusable = previous?.status === 'passed' && previous.reviewedAt && !Number.isNaN(Date.parse(previous.reviewedAt))
    && Array.isArray(previous.issues) && previous.issues.length === 0;
  scaffold.batches = reviewBatches(await reviewContext(jobPath, glossaryPath)).map(batch => {
    const old = reusable && previous.batches?.find(item => item.cueStart === batch.cueStart && item.cueEnd === batch.cueEnd);
    const covered = previous?.coverage?.some(item => item.cueStart <= batch.cueStart && item.cueEnd >= batch.cueEnd);
    const reused = Boolean(old && covered && sameReviewInput(old.input, batch.input));
    return { ...batch, reused };
  });
  scaffold.coverage = scaffold.batches.filter(batch => batch.reused).map(({cueStart, cueEnd}) => ({cueStart, cueEnd}));
  scaffold.instructions = 'Review each batch with reused=false, including its neighboring context. Preserve batches and their input snapshots. Add reviewed ranges to coverage, resolve issues, then set status=passed and reviewedAt. If wording changes, scaffold again. First review and legacy records require full coverage.';
  await atomicWriteJson(paths.aiReview, scaffold);
  return scaffold;
}

function validateSemanticAlignment(sourceCues, semanticCues, issues) {
  if (sourceCues.length !== semanticCues.length) {
    addIssue(issues, 'error', 'semantic_cue_count', `Semantic Chinese has ${semanticCues.length} cues; source has ${sourceCues.length}.`);
    return;
  }
  sourceCues.forEach((source, index) => {
    const translated = semanticCues[index];
    if (!sameTime(source.start, translated.start) || !sameTime(source.end, translated.end)) {
      addIssue(issues, 'error', 'semantic_timing_changed', 'Semantic translation must preserve the source cue timestamp.', index + 1);
    }
  });
}

export function validateSegmentedLayer(masterCues, readableCues, issues, {
  prefix = 'readable',
  textMessage = 'Readable text must be a layout-only segmentation of its master subtitle.',
  comparison = cueTextForComparison,
  joiner = '',
} = {}) {
  let readableIndex = 0;
  for (let masterIndex = 0; masterIndex < masterCues.length; masterIndex += 1) {
    const master = masterCues[masterIndex];
    const members = [];
    while (readableIndex < readableCues.length) {
      const candidate = readableCues[readableIndex];
      if (candidate.start < master.start - 0.002) {
        addIssue(issues, 'error', `${prefix}_outside_source_span`, 'Readable cue begins before its source span.', readableIndex + 1);
        readableIndex += 1;
        continue;
      }
      if (candidate.start >= master.end - 0.002 && !sameTime(candidate.start, master.start)) break;
      if (candidate.end > master.end + 0.002) {
        addIssue(issues, 'error', `${prefix}_outside_source_span`, 'Readable cue ends after its source span.', readableIndex + 1);
      }
      members.push(candidate);
      readableIndex += 1;
      if (sameTime(candidate.end, master.end)) break;
    }
    if (members.length === 0) {
      addIssue(issues, 'error', `${prefix}_missing_span`, 'No readable cue covers this source cue.', masterIndex + 1);
      continue;
    }
    if (!sameTime(members[0].start, master.start) || !sameTime(members.at(-1).end, master.end)) {
      addIssue(issues, 'error', `${prefix}_span_changed`, 'Readable segmentation must preserve the source cue outer boundary.', masterIndex + 1);
    }
    for (let index = 1; index < members.length; index += 1) {
      if (!sameTime(members[index - 1].end, members[index].start)) {
        addIssue(issues, 'error', `${prefix}_internal_timing`, 'Readable child cues must be contiguous and non-overlapping.', masterIndex + 1);
      }
    }
    const combined = members.map((item) => comparison(item.text)).join(joiner);
    if (combined !== comparison(master.text)) {
      addIssue(issues, 'error', `${prefix}_text_drift`, textMessage, masterIndex + 1);
    }
  }
  if (readableIndex < readableCues.length) addIssue(issues, 'error', `${prefix}_extra_cues`, 'Readable output contains cues outside the source timeline.');
}

function buildTargetTermLookup(terms) {
  const byAnchor = new Map();
  const lengths = new Set();
  for (const term of [...new Set(terms.map((value) => cueTextForComparison(value).normalize('NFC')).filter(Boolean))]) {
    const characters = [...term];
    if (characters.length < 2) continue;
    const length = Math.min(3, characters.length);
    const anchor = characters.slice(0, length).join('');
    lengths.add(length);
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
    byAnchor.get(anchor).push(term);
  }
  return { byAnchor, lengths: [...lengths] };
}

function relevantTargetTerms(lookup, text) {
  const characters = [...text];
  const candidates = new Set();
  for (const length of lookup.lengths) {
    for (let index = 0; index <= characters.length - length; index += 1) {
      const terms = lookup.byAnchor.get(characters.slice(index, index + length).join(''));
      if (terms) terms.forEach((term) => candidates.add(term));
    }
  }
  return [...candidates].filter((term) => text.includes(term));
}

function validateProtectedTermBoundaries(masterCues, readableCues, targetTerms, issues) {
  const lookup = buildTargetTermLookup(targetTerms);
  let readableIndex = 0;
  for (let masterIndex = 0; masterIndex < masterCues.length; masterIndex += 1) {
    const master = masterCues[masterIndex];
    const members = [];
    while (readableIndex < readableCues.length) {
      const candidate = readableCues[readableIndex];
      if (candidate.start < master.start - 0.002) {
        readableIndex += 1;
        continue;
      }
      if (candidate.start >= master.end - 0.002 && !sameTime(candidate.start, master.start)) break;
      members.push(candidate);
      readableIndex += 1;
      if (sameTime(candidate.end, master.end)) break;
    }
    if (members.length === 0) continue;
    const rawBoundaries = [];
    const rawPieces = [];
    let offset = 0;
    members.forEach((member, memberIndex) => {
      const lines = member.text.split('\n');
      lines.forEach((line, lineIndex) => {
        const piece = cueTextForComparison(line);
        rawPieces.push(piece);
        offset += piece.length;
        if (lineIndex < lines.length - 1) rawBoundaries.push(offset);
      });
      if (memberIndex < members.length - 1) rawBoundaries.push(offset);
    });
    if (rawBoundaries.length === 0) continue;
    const compactRawReadable = rawPieces.join('');
    const graphemeCuts = new Set([...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(compactRawReadable)]
      .map((entry) => entry.index).concat(compactRawReadable.length));
    if (rawBoundaries.some((boundary) => !graphemeCuts.has(boundary))) {
      addIssue(issues, 'error', 'grapheme_split_across_cues', 'A Unicode grapheme is split across readable cue or line boundaries.', masterIndex + 1);
    }
    const compactMaster = cueTextForComparison(master.text).normalize('NFC');
    const terms = relevantTargetTerms(lookup, compactMaster);
    if (terms.length === 0) continue;
    const boundaries = rawBoundaries.map((boundary) => compactRawReadable.slice(0, boundary).normalize('NFC').length);
    for (const term of terms) {
      let start = compactMaster.indexOf(term);
      while (start >= 0) {
        const end = start + term.length;
        if (boundaries.some((boundary) => start < boundary && boundary < end)) {
          addIssue(issues, 'error', 'term_split_across_cues', `Approved target term ${term} is split across readable cue or line boundaries.`, masterIndex + 1);
          break;
        }
        start = compactMaster.indexOf(term, start + 1);
      }
    }
  }
}

function validateProtectedSourceTermBoundaries(masterCues, readableCues, termMatches, issues) {
  const matchesByCue = new Map();
  for (const entry of termMatches) {
    for (const [index, forms] of entry.matchedFormsByIndex) {
      const protectedForms = [...forms].filter((form) => normalizedSourceForm(form).length > 1);
      if (protectedForms.length === 0) continue;
      if (!matchesByCue.has(index)) matchesByCue.set(index, []);
      matchesByCue.get(index).push({ caseSensitive: entry.caseSensitive, forms: protectedForms });
    }
  }
  let readableIndex = 0;
  for (let masterIndex = 0; masterIndex < masterCues.length; masterIndex += 1) {
    const master = masterCues[masterIndex];
    const members = [];
    while (readableIndex < readableCues.length) {
      const candidate = readableCues[readableIndex];
      if (candidate.start < master.start - 0.002) {
        readableIndex += 1;
        continue;
      }
      if (candidate.start >= master.end - 0.002 && !sameTime(candidate.start, master.start)) break;
      members.push(candidate);
      readableIndex += 1;
      if (sameTime(candidate.end, master.end)) break;
    }
    const entries = matchesByCue.get(masterIndex) ?? [];
    if (members.length === 0 || entries.length === 0) continue;
    const pieces = members.flatMap((member) => member.text.split('\n').map((line) => normalizeSubtitleText(line).normalize('NFKC')));
    if (pieces.length < 2) continue;
    const boundaries = [];
    let offset = 0;
    pieces.forEach((piece, index) => {
      offset += piece.length;
      if (index < pieces.length - 1) {
        boundaries.push(offset);
        offset += 1;
      }
    });
    const masterText = normalizeSubtitleText(master.text).normalize('NFKC');
    for (const entry of entries) {
      for (const form of entry.forms) {
        const pattern = sourceTermPattern(form, entry.caseSensitive);
        let match;
        while ((match = pattern.exec(masterText)) !== null) {
          const start = match.index + match[1].length;
          const end = match.index + match[0].length;
          if (boundaries.some((boundary) => start < boundary && boundary < end)) {
            addIssue(issues, 'error', 'source_term_split_across_cues', `Approved source term ${normalizedSourceForm(form)} is split across readable English cue or line boundaries.`, masterIndex + 1);
            break;
          }
        }
      }
    }
  }
}

function validateChineseReadability(cues, issues) {
  cues.forEach((item, index) => {
    const lines = item.text.split('\n').filter((line) => line.trim());
    if (lines.length !== 1) addIssue(issues, 'error', 'too_many_lines', 'Readable Chinese requires exactly one physical line.', index + 1);
    for (const line of lines) {
      const units = displayUnits(line);
      if (units > 24) addIssue(issues, 'error', 'line_too_wide', `Chinese line is ${units} display units; maximum is 24.`, index + 1);
      else if (units > 16) addIssue(issues, 'warning', 'line_above_target', `Chinese line is ${units} display units; target is 16.`, index + 1);
    }
    const duration = item.end - item.start;
    const speed = displayUnits(item.text.replaceAll('\n', '')) / duration;
    if (duration < 5 / 6) addIssue(issues, 'warning', 'short_duration', `Cue duration is ${duration.toFixed(3)}s.`, index + 1);
    if (speed > 9) addIssue(issues, 'warning', 'high_reading_speed', `Reading speed is ${speed.toFixed(2)} display units/s.`, index + 1);
  });
}

function validateEnglishReadability(cues, issues) {
  cues.forEach((item, index) => {
    const lines = item.text.split('\n').filter((line) => line.trim());
    if (lines.length !== 1) addIssue(issues, 'error', 'readable_en_line_count', 'Readable English must contain exactly one physical line.', index + 1);
    if (normalizeSubtitleText(item.text).length > 84) addIssue(issues, 'error', 'readable_en_too_wide', 'Readable English exceeds 84 characters.', index + 1);
  });
}

function validateNumbers(sourceCues, semanticCues, issues) {
  if (sourceCues.length !== semanticCues.length) return;
  sourceCues.forEach((source, index) => {
    const sourceNumbers = normalizedNumbers(source.text);
    const translatedNumbers = normalizedNumbers(semanticCues[index].text);
    if (JSON.stringify(sourceNumbers) !== JSON.stringify(translatedNumbers)) {
      addIssue(issues, 'warning', 'number_mismatch', `Source numbers [${sourceNumbers.join(', ')}] differ from Chinese [${translatedNumbers.join(', ')}].`, index + 1);
    }
  });
}

function validCompletedTimestamp(file) {
  return !file.completed || Boolean(file.updatedAt && !Number.isNaN(Date.parse(file.updatedAt)));
}

function validateTerminology({ jobId, glossary, decisions, candidates, sourceCues, semanticCues, issues }) {
  const candidateLint = lintTermFile(candidates);
  const decisionLint = lintTermFile(decisions, { decisions: true });
  candidateLint.errors.forEach((message) => addIssue(issues, 'error', 'term_candidates_invalid', message));
  decisionLint.errors.forEach((message) => addIssue(issues, 'error', 'term_decisions_invalid', message));
  if (candidates.job !== jobId) addIssue(issues, 'error', 'term_candidates_job', 'Term candidates belong to a different job.');
  if (decisions.job !== jobId) addIssue(issues, 'error', 'term_decisions_job', 'Term decisions belong to a different job.');
  if (!validCompletedTimestamp(candidates)) addIssue(issues, 'error', 'term_candidates_timestamp', 'Completed term candidates require a valid updatedAt timestamp.');
  if (!validCompletedTimestamp(decisions)) addIssue(issues, 'error', 'term_decisions_timestamp', 'Completed term decisions require a valid updatedAt timestamp.');
  if (!candidates.completed) addIssue(issues, 'error', 'term_extraction_incomplete', 'Term candidate extraction is not marked completed.');
  if (!decisions.completed) addIssue(issues, 'error', 'term_decisions_incomplete', 'Term decisions are not marked completed.');
  if (!candidateLint.passed || !decisionLint.passed || !Array.isArray(candidates.terms) || !Array.isArray(decisions.terms)) return [];
  for (const raw of candidates.terms) {
    const candidate = normalizedCandidate(raw);
    for (const cueIndex of candidate.cueIndexes) {
      const source = sourceCues[cueIndex - 1];
      if (!source) {
        addIssue(issues, 'error', 'term_candidate_range', `${candidate.en} cites missing source cue ${cueIndex}.`);
        continue;
      }
      const forms = [candidate.en, ...candidate.aliases];
      if (!forms.some((form) => containsSourceTerm(source.text, form, candidate.caseSensitive))) {
        addIssue(issues, 'error', 'term_candidate_evidence', `${candidate.en} does not occur in cited source cue ${cueIndex}.`, cueIndex);
      }
    }
  }
  for (const candidate of candidates.terms) {
    const candidateCaseSensitive = candidate.caseSensitive ?? defaultCaseSensitive(candidate.en);
    const candidateForms = [candidate.en, ...(candidate.aliases ?? [])];
    const decision = decisions.terms.find((item) => {
      const decisionCaseSensitive = item.caseSensitive ?? defaultCaseSensitive(item.en);
      const decisionForms = [item.en, ...(item.aliases ?? [])];
      return candidateForms.every((candidateForm) => decisionForms.some((decisionForm) => sourceFormCovers(
        decisionForm,
        decisionCaseSensitive,
        candidateForm,
        candidateCaseSensitive,
      )));
    });
    if (!decision) addIssue(issues, 'error', 'candidate_without_decision', `No decision exists for candidate ${candidate.en}.`);
    else if (decision.approvalStatus === 'review-required') addIssue(issues, 'error', 'term_unresolved', `Terminology is unresolved: ${candidate.en}.`);
  }
  for (const decision of decisions.terms) {
    if (decision.approvalStatus === 'approved' && decision.syncScope === 'project') {
      const decisionCaseSensitive = decision.caseSensitive ?? defaultCaseSensitive(decision.en);
      const decisionForms = [decision.en, ...(decision.aliases ?? [])];
      const applied = glossary.terms.find((term) => {
        const termCaseSensitive = term.caseSensitive ?? defaultCaseSensitive(term.en);
        const termForms = [term.en, ...(term.aliases ?? [])];
        return decisionForms.every((decisionForm) => termForms.some((termForm) => sourceFormCovers(
          termForm,
          termCaseSensitive,
          decisionForm,
          decisionCaseSensitive,
        )));
      });
      if (!applied || applied.zhHans !== decision.zhHans) {
        addIssue(issues, 'error', 'project_term_not_applied', `Approved project term is not current in glossary.json: ${decision.en}.`);
      }
    }
  }
  if (sourceCues.length !== semanticCues.length) return [];
  const active = activeTermsForJob(glossary.terms, decisions.terms);
  const jobTerms = new Set(decisions.terms.filter((term) => term.approvalStatus === 'approved' && term.syncScope === 'job'));
  const cueIndex = sourceCueIndex(sourceCues);
  const allCueIndexes = sourceCues.map((_, index) => index);
  const matches = active.map((term) => {
    const forms = [term.en, ...(term.aliases ?? [])].filter(Boolean);
    const caseSensitive = term.caseSensitive ?? defaultCaseSensitive(term.en);
    const matchedIndexes = new Set();
    const matchedFormsByIndex = new Map();
    for (const form of forms) {
      for (const index of candidateCueIndexes(form, cueIndex, allCueIndexes)) {
        if (!containsSourceTerm(sourceCues[index].text, form, caseSensitive)) continue;
        matchedIndexes.add(index);
        if (!matchedFormsByIndex.has(index)) matchedFormsByIndex.set(index, new Set());
        matchedFormsByIndex.get(index).add(form);
      }
    }
    return { term, forms, caseSensitive, matchedIndexes, matchedFormsByIndex, isJobTerm: jobTerms.has(term) };
  });
  const jobOverridesByCue = new Map();
  for (const entry of matches.filter((item) => item.isJobTerm)) {
    for (const index of entry.matchedIndexes) {
      if (!jobOverridesByCue.has(index)) jobOverridesByCue.set(index, new Map());
      const overrides = jobOverridesByCue.get(index);
      for (const form of entry.forms) {
        const exact = normalizedSourceForm(form);
        const bucket = sourceFormBucket(exact);
        if (!overrides.has(bucket)) overrides.set(bucket, []);
        overrides.get(bucket).push({ form: exact, caseSensitive: entry.caseSensitive });
      }
    }
  }
  for (const entry of matches) {
    const { term, matchedIndexes } = entry;
    for (const index of matchedIndexes) {
      if (!entry.isJobTerm) {
        const overrides = jobOverridesByCue.get(index);
        if (overrides && !hasUnshadowedSourceTerm(sourceCues[index].text, entry, overrides)) continue;
      }
      if (!semanticCues[index].text.normalize('NFC').includes(String(term.zhHans).normalize('NFC'))) {
        addIssue(issues, 'error', 'missing_active_term', `${term.en} should use ${term.zhHans}.`, index + 1);
      }
    }
  }
  return matches;
}

export function activeTermsForJob(glossaryTerms, decisionTerms) {
  const jobTerms = decisionTerms.filter((term) => term.approvalStatus === 'approved' && term.syncScope === 'job');
  const jobForms = new Map();
  for (const term of jobTerms) {
    const caseSensitive = term.caseSensitive ?? defaultCaseSensitive(term.en);
    for (const form of [term.en, ...(term.aliases ?? [])]) {
      const bucket = sourceFormBucket(form);
      if (!jobForms.has(bucket)) jobForms.set(bucket, []);
      jobForms.get(bucket).push({ form, caseSensitive });
    }
  }
  const overlapsJobTerm = (projectTerm) => {
    const caseSensitive = projectTerm.caseSensitive ?? defaultCaseSensitive(projectTerm.en);
    return [projectTerm.en, ...(projectTerm.aliases ?? [])].every((form) => (
      (jobForms.get(sourceFormBucket(form)) ?? []).some((jobForm) => sourceFormCovers(
        jobForm.form,
        jobForm.caseSensitive,
        form,
        caseSensitive,
      ))
    ));
  };
  return [
    ...glossaryTerms.filter((term) => !overlapsJobTerm(term)),
    ...jobTerms,
  ];
}

export function isTerminologyIssueCode(code) {
  return code === 'glossary_invalid' || code.includes('term') || code.includes('candidate');
}

function validateUntranslatedEnglish(semanticCues, glossary, decisions, issues) {
  const approvedLatin = new Set([
    ...glossary.terms.map((term) => term.zhHans),
    ...(decisions.terms ?? []).filter((term) => term.approvalStatus === 'approved').map((term) => term.zhHans),
  ].flatMap((value) => String(value ?? '').match(/[A-Za-z][A-Za-z'-]{1,}/g) ?? [])
    .map((value) => value.toLocaleLowerCase('en-US')));
  semanticCues.forEach((cue, index) => {
    const words = cue.text.match(/[A-Za-z][A-Za-z'-]{1,}/g) ?? [];
    const expected = [...new Set(words.filter((word) => approvedLatin.has(word.toLocaleLowerCase('en-US'))))];
    const unexpected = [...new Set(words.filter((word) => !approvedLatin.has(word.toLocaleLowerCase('en-US'))))];
    if (expected.length > 0) addIssue(issues, 'warning', 'approved_latin', `Approved terminology preserves Latin text: ${expected.join(', ')}.`, index + 1);
    if (unexpected.length > 0) addIssue(issues, 'warning', 'untranslated_latin', `Review Latin text: ${unexpected.join(', ')}.`, index + 1);
  });
}

function validateAiReview({ review, jobId, cueCount, issues }) {
  if (review.schemaVersion !== 1) addIssue(issues, 'error', 'ai_review_schema', 'AI review schemaVersion must be 1.');
  if (review.job !== jobId) addIssue(issues, 'error', 'ai_review_job', 'AI review belongs to a different job.');
  if (review.status !== 'passed') addIssue(issues, 'error', 'ai_review_not_passed', 'Independent AI review has not passed.');
  if (!review.reviewedAt || Number.isNaN(Date.parse(review.reviewedAt))) addIssue(issues, 'error', 'ai_review_timestamp', 'AI review requires a valid reviewedAt timestamp.');
  if (!reviewCoverageIsComplete(review.coverage, cueCount)) addIssue(issues, 'error', 'ai_review_incomplete_coverage', `AI review must cover all ${cueCount} source cues.`);
  if (!Array.isArray(review.issues)) {
    addIssue(issues, 'error', 'ai_review_issues_invalid', 'AI review issues must be an array.');
    return;
  }
  if (review.issues.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    addIssue(issues, 'error', 'ai_review_issue_invalid', 'Every AI review issue must be an object.');
    return;
  }
  const unresolved = review.issues.filter((item) => item.resolved !== true);
  if (unresolved.length > 0) addIssue(issues, 'error', 'ai_review_unresolved_issues', `${unresolved.length} AI review issue(s) remain unresolved.`);
}

function validateAss(ass, readableZh, readableEn, issues, language = 'bilingual') {
  let section = '';
  let styleFormat = null;
  let eventFormat = null;
  const styleRows = [];
  for (const rawLine of ass.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLocaleLowerCase('en-US');
      continue;
    }
    if (section === 'v4+ styles' && /^Format:/i.test(line)) styleFormat = line.slice(line.indexOf(':') + 1).split(',').map((field) => field.trim());
    if (section === 'v4+ styles' && /^Style:/i.test(line)) styleRows.push(line.slice(line.indexOf(':') + 1).split(',').map((field) => field.trim()));
    if (section === 'events' && /^Format:/i.test(line)) eventFormat = line.slice(line.indexOf(':') + 1).split(',').map((field) => field.trim());
  }
  if (!styleFormat || styleFormat.length !== 23) addIssue(issues, 'error', 'ass_style_format', 'ASS V4+ style Format must contain exactly 23 fields.');
  if (styleRows.length !== 1 || styleRows[0]?.length !== 23 || styleRows[0]?.[0] !== 'Bilingual') {
    addIssue(issues, 'error', 'ass_style_invalid', 'ASS must contain exactly one 23-field Bilingual style.');
  }
  if (!eventFormat || eventFormat.length !== 10) addIssue(issues, 'error', 'ass_event_format', 'ASS Events Format must contain exactly 10 fields.');
  if (styleRows.length === 1 && styleRows[0]?.length === 23) {
    try {
      const expected = buildBilingualAss({ zhCues: readableZh, enCues: readableEn, language, fontName: styleRows[0][1] });
      if (ass.replaceAll('\r\n', '\n') !== expected) {
        addIssue(issues, 'error', 'ass_structure_drift', 'ASS must preserve the exact generated header, style, event fields, and override tags. Regenerate it instead of editing it by hand.');
      }
    } catch (error) {
      addIssue(issues, 'error', 'ass_structure_invalid', error.message);
    }
  }
  const dialogueRows = ass.split(/\r?\n/).filter((line) => /^Dialogue:/i.test(line));
  if (dialogueRows.length !== readableZh.length) addIssue(issues, 'error', 'ass_event_count', `ASS has ${dialogueRows.length} Dialogue events; expected ${readableZh.length}.`);
  if (dialogueRows.some((line) => (line.match(/\\N/g) ?? []).length !== (language === 'bilingual' ? 1 : 0))) {
    addIssue(issues, 'error', 'ass_row_count', 'Each bilingual ASS event must contain exactly one Chinese row and one English row.');
  }
  let parsed;
  try {
    parsed = parseAss(ass);
  } catch (error) {
    addIssue(issues, 'error', 'ass_invalid', error.message);
    return;
  }
  if (parsed.length !== readableZh.length || readableEn.length !== readableZh.length) return;
  parsed.forEach((event, index) => {
    if (!sameTime(event.start, readableZh[index].start) || !sameTime(event.end, readableZh[index].end)) {
      addIssue(issues, 'error', 'ass_timing_drift', 'ASS event timestamp differs from readable subtitles.', index + 1);
    }
    const expectedText = cueTextForComparison(language === 'zh' ? readableZh[index].text : language === 'en' ? readableEn[index].text : `${readableZh[index].text}\n${readableEn[index].text}`);
    if (cueTextForComparison(event.text) !== expectedText) {
      addIssue(issues, 'error', 'ass_text_drift', 'ASS event text differs from readable Chinese/English.', index + 1);
    }
  });
}

export function renderQaReport(report, paths) {
  const lines = [
    '# Subtitle Me QA Report', '',
    `Result: **${report.passed ? 'PASS' : 'FAIL'}**  `,
    `Generated: ${report.generatedAt}  `,
    `Source cues: ${report.stats.sourceCues}  `,
    `Readable cues: ${report.stats.readableCues}`, '',
    '## Artifacts', '',
    `- Semantic Chinese: \`${paths.semanticZh.replaceAll('\\', '/')}\``,
    `- Readable Chinese: \`${paths.readableZh.replaceAll('\\', '/')}\``,
    `- Machine QA: \`${paths.qa.replaceAll('\\', '/')}\``, '',
  ];
  for (const [heading, items] of [['Errors', report.errors], ['Warnings', report.warnings]]) {
    lines.push(`## ${heading}`, '');
    if (items.length === 0) lines.push('None.', '');
    else {
      for (const item of items) lines.push(`- ${item.code}${item.cue ? ` (cue ${item.cue})` : ''}: ${item.message}`);
      lines.push('');
    }
  }
  lines.push('Warnings require human or AI review in context. They are never hidden from the final handoff.', '');
  return lines.join('\n');
}

async function loadArtifacts(entries) {
  const artifacts = {};
  for (const [name, path] of Object.entries(entries)) {
    const bytes = await fileSize(path);
    if (bytes > 64 * 1024 * 1024) throw new UserError(`${name} is ${(bytes / 1024 / 1024).toFixed(1)} MiB; the QA artifact limit is 64 MiB.`);
    artifacts[name] = { path, text: await readUtf8(path) };
  }
  return artifacts;
}

export async function runQa({ jobPath, job, glossaryPath }) {
  const paths = jobArtifactPaths(jobPath);
  const required = {
    source: paths.source,
    semanticZh: paths.semanticZh,
    readableZh: paths.readableZh,
    glossary: glossaryPath,
    termCandidates: paths.termCandidates,
    termDecisions: paths.termDecisions,
    aiReview: paths.aiReview,
    ...(job.options?.bilingualAss ? { readableEn: paths.readableEn, ass: paths.ass } : {}),
    ...(job.options?.chineseTitle ? { title: paths.title } : {}),
    ...(job.options?.videoDescription ? { description: paths.description } : {}),
  };
  for (const path of Object.values(required)) {
    if (!(await pathExists(path))) throw new UserError(`Required artifact is missing: ${path}`);
  }
  const artifacts = await loadArtifacts(required);
  const sourceCues = parseSrt(artifacts.source.text);
  const semanticCues = parseSrt(artifacts.semanticZh.text);
  const readableCues = parseSrt(artifacts.readableZh.text);
  const glossary = parseJsonSnapshot(artifacts.glossary, glossaryPath);
  const candidates = parseJsonSnapshot(artifacts.termCandidates, paths.termCandidates);
  const decisions = parseJsonSnapshot(artifacts.termDecisions, paths.termDecisions);
  const review = parseJsonSnapshot(artifacts.aiReview, paths.aiReview);
  const issues = [];
  const glossaryLint = lintGlossary(glossary);
  glossaryLint.errors.forEach((message) => addIssue(issues, 'error', 'glossary_invalid', message));
  glossaryLint.warnings.forEach((message) => addIssue(issues, 'warning', 'glossary_warning', message));
  findTimelineIssues(sourceCues).forEach((item) => addIssue(issues, 'warning', item.code, 'Source timing may need review. subtitle-me does not shift source synchronization.', item.cue, item));
  validateSemanticAlignment(sourceCues, semanticCues, issues);
  validateSegmentedLayer(semanticCues, readableCues, issues, {
    prefix: 'readable',
    comparison: (text) => cueTextForComparison(text).normalize('NFC'),
  });
  validateChineseReadability(readableCues, issues);
  validateNumbers(sourceCues, semanticCues, issues);
  let termMatches = [];
  if (glossaryLint.passed) {
    termMatches = validateTerminology({ jobId: job.id, glossary, decisions, candidates, sourceCues, semanticCues, issues });
    validateProtectedTermBoundaries(semanticCues, readableCues, [
      ...glossary.terms.map((term) => term.zhHans),
      ...(Array.isArray(decisions?.terms) ? decisions.terms : [])
        .filter((term) => term?.approvalStatus === 'approved')
        .map((term) => term.zhHans),
    ], issues);
    validateUntranslatedEnglish(semanticCues, glossary, decisions, issues);
  }
  validateAiReview({ review, jobId: job.id, cueCount: sourceCues.length, issues });
  if (review.batches) {
    const current = reviewBatches(await reviewContext(jobPath, glossaryPath));
    if (!Array.isArray(review.batches) || review.batches.length !== current.length || current.some((batch, index) =>
      batch.cueStart !== review.batches[index]?.cueStart || batch.cueEnd !== review.batches[index]?.cueEnd
      || !sameReviewInput(batch.input, review.batches[index]?.input))) {
      addIssue(issues, 'error', 'ai_review_stale', 'Reviewed inputs changed. Run review scaffold and review affected batches.');
    }
  }
  if (job.options?.bilingualAss) {
    const readableEn = parseSrt(artifacts.readableEn.text);
    validateSegmentedLayer(sourceCues, readableEn, issues, {
      prefix: 'readable_en',
      textMessage: 'Readable English must be a layout-only segmentation of the normalized source.',
      comparison: (text) => normalizeSubtitleText(text),
      joiner: ' ',
    });
    validateProtectedSourceTermBoundaries(sourceCues, readableEn, termMatches, issues);
    validateEnglishReadability(readableEn, issues);
    if (readableEn.length !== readableCues.length) addIssue(issues, 'error', 'ass_alignment', 'Readable English and Chinese cue counts differ.');
    else readableEn.forEach((item, index) => {
      if (!sameTime(item.start, readableCues[index].start) || !sameTime(item.end, readableCues[index].end)) {
        addIssue(issues, 'error', 'ass_alignment', 'Readable English and Chinese timestamps differ.', index + 1);
      }
    });
    validateAss(artifacts.ass.text, readableCues, readableEn, issues, job.options.subtitleLanguage ?? 'bilingual');
  }
  if (job.options?.chineseTitle) {
    const lines = artifacts.title.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 2 || !/^Original:\s*\S+/.test(lines[0]) || !/^Chinese:\s*\S+/.test(lines[1])) {
      addIssue(issues, 'error', 'title_invalid', 'title.zh-Hans.md must contain exactly one non-empty Original line followed by one non-empty Chinese line.');
    }
  }
  if (job.options?.videoDescription) {
    const description = artifacts.description.text;
    if (!/^来源：[ \t]*https?:\/\/\S+/m.test(description) || !/^作者：[ \t]*\S+/m.test(description)
      || !description.split(/\r?\n/).some(line => line.trim() && !/^(#|来源：|作者：)/.test(line))) {
      addIssue(issues, 'error', 'description_invalid', 'Video description needs a summary, source URL and creator. Use 来源： and 作者： labels.');
    }
  }
  const errors = issues.filter((item) => item.severity === 'error');
  const warnings = issues.filter((item) => item.severity === 'warning');
  const report = {
    schemaVersion: 1,
    job: job.id,
    generatedAt: utcNow(),
    passed: errors.length === 0,
    options: {
      bilingualAss: Boolean(job.options?.bilingualAss),
      chineseTitle: Boolean(job.options?.chineseTitle),
    },
    stats: { sourceCues: sourceCues.length, semanticCues: semanticCues.length, readableCues: readableCues.length },
    errors,
    warnings,
  };
  await atomicWriteJson(paths.qa, report);
  await atomicWrite(paths.report, renderQaReport(report, paths));
  return report;
}
