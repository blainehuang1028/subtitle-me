import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceTermPattern, defaultCaseSensitive } from './common.mjs';
import { parseSrt } from './subtitles.mjs';

// Visible text snapshots, not hashes. A trusted local editing aid, not attestation.
export async function reviewContext(jobPath, glossaryPath) {
  const read = (path) => readFile(path, 'utf8');
  const source = parseSrt(await read(join(jobPath, 'source/source.en.srt')));
  const chinese = parseSrt(await read(join(jobPath, 'subtitles/semantic.zh-Hans.srt')));
  const glossary = JSON.parse(await read(glossaryPath));
  const decisions = JSON.parse(await read(join(jobPath, 'qa/term-decisions.json')));
  const candidates = JSON.parse(await read(join(jobPath, 'qa/term-candidates.json')));
  const sourceText = source.map(cue => cue.text).join('\n');
  const relevant = (glossary.terms ?? []).filter(term => [term.en, ...(term.aliases ?? [])].some(form => sourceTermPattern(form, term.caseSensitive ?? defaultCaseSensitive(form)).test(sourceText)));
  return { source, chinese, terms: { glossary: relevant, decisions: decisions.terms, candidates: candidates.terms } };
}

export function reviewBatches(context, size = 25) {
  const batches = [];
  for (let start = 0; start < context.source.length; start += size) {
    const end = Math.min(start + size, context.source.length);
    batches.push({ cueStart: start + 1, cueEnd: end, input: {
      source: context.source.slice(Math.max(0, start - 1), end + 1),
      chinese: context.chinese.slice(Math.max(0, start - 1), end + 1),
      terms: context.terms,
    } });
  }
  return batches;
}

export function sameReviewInput(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
