import { displayUnits, normalizeSubtitleText } from './subtitles.mjs';
import {
  defaultCaseSensitive,
  normalizedSourceForm,
  sourceFormBucket,
  sourceTermPattern,
  UserError,
} from './common.mjs';

const STRONG_BREAKS = new Set(['。', '！', '？', '；', '!', '?', ';']);
const SOFT_BREAKS = new Set(['，', '、', '：', ',', ':']);
const OPENING = new Set(['（', '【', '《', '“', '‘', '(', '[', '<', '"', "'"]);
const CLOSING = new Set(['）', '】', '》', '”', '’', ')', ']', '>', '，', '。', '！', '？', '；', '：', ',', '.', '!', '?', ';', ':']);
const CONNECTIVES = ['但', '而', '因为', '所以', '如果', '不过', '同时', '然后', '以及', '并且'];
const GRAPHEME_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });

function insidePairedPunctuation(text, cut) {
  return [['（', '）'], ['【', '】'], ['《', '》'], ['“', '”'], ['‘', '’'], ['(', ')'], ['[', ']']]
    .some(([left, right]) => text.lastIndexOf(left, cut - 1) > text.lastIndexOf(right, cut - 1));
}

function graphemeBoundaries(text) {
  return new Set([...GRAPHEME_SEGMENTER.segment(text)].map((entry) => entry.index).concat(text.length));
}

function protectedChineseCuts(text, protectedTerms, boundaries) {
  const normalized = text.normalize('NFC');
  const spans = [];
  for (const term of protectedTerms) {
    let start = normalized.indexOf(term);
    while (start >= 0) {
      spans.push([start, start + term.length]);
      start = normalized.indexOf(term, start + 1);
    }
  }
  const protectedCuts = new Set();
  for (const cut of boundaries) {
    if (cut <= 0 || cut >= text.length) continue;
    const normalizedCut = text.slice(0, cut).normalize('NFC').length;
    if (spans.some(([start, end]) => start < normalizedCut && normalizedCut < end)) protectedCuts.add(cut);
  }
  return protectedCuts;
}

function validChineseCut(text, cut, protectedCuts, boundaries) {
  if (cut <= 0 || cut >= text.length) return true;
  if (!boundaries.has(cut) || insidePairedPunctuation(text, cut) || protectedCuts.has(cut)) return false;
  const previous = text[cut - 1];
  const current = text[cut];
  if (OPENING.has(previous) || CLOSING.has(current) || current === '的') return false;
  if (/\p{Number}/u.test(previous) && /[\p{Letter}%％°℃℉]/u.test(current)) return false;
  if (/[A-Za-z0-9]/.test(previous) && /[A-Za-z0-9]/.test(current)) return false;
  return true;
}

function chineseBoundaryPenalty(text, cut) {
  if (cut <= 0 || cut >= text.length) return 0;
  const previous = text[cut - 1];
  const suffix = text.slice(cut);
  if (STRONG_BREAKS.has(previous)) return 0;
  if (SOFT_BREAKS.has(previous) || /\s/.test(previous)) return 1;
  if (CONNECTIVES.some((word) => suffix.startsWith(word))) return 2;
  if (/[了着过里中上下前后时吧呢吗啊]/.test(previous)) return 4;
  if (/[A-Za-z0-9]/.test(previous) !== /[A-Za-z0-9]/.test(text[cut])) return 5;
  return 40;
}

function displayUnitPrefix(text) {
  const prefix = new Float64Array(text.length + 1);
  let offset = 0;
  let total = 0;
  for (const character of text) {
    const next = offset + character.length;
    total += displayUnits(character);
    prefix[next] = total;
    offset = next;
  }
  return prefix;
}

function partitionChinese(text, count, protectedTerms, maximumUnits) {
  const normalized = normalizeSubtitleText(text);
  if (count === 1) return displayUnits(normalized) <= maximumUnits ? [normalized] : null;
  const boundaries = graphemeBoundaries(normalized);
  const protectedCuts = protectedChineseCuts(normalized, protectedTerms, boundaries);
  const positions = [0];
  let cut = 0;
  for (const character of normalized) {
    cut += character.length;
    if (cut >= normalized.length) break;
    if (validChineseCut(normalized, cut, protectedCuts, boundaries) && chineseBoundaryPenalty(normalized, cut) < 40) positions.push(cut);
  }
  positions.push(normalized.length);
  const prefix = displayUnitPrefix(normalized);
  const target = prefix[normalized.length] / count;
  let states = new Map([[0, { end: 0, positionIndex: 0, cost: 0, previous: null }]]);
  for (let used = 0; used < count; used += 1) {
    const next = new Map();
    for (const state of states.values()) {
      const remainingCount = count - used - 1;
      for (let positionIndex = state.positionIndex + 1; positionIndex < positions.length; positionIndex += 1) {
        const end = positions[positionIndex];
        const units = prefix[end] - prefix[state.end];
        if (units > maximumUnits) break;
        const chunk = normalized.slice(state.end, end).trim();
        if (!chunk) continue;
        if (remainingCount === 0 && end !== normalized.length) continue;
        if (remainingCount > 0) {
          if (end === normalized.length || positions.length - positionIndex - 1 < remainingCount) continue;
          if (prefix[normalized.length] - prefix[end] > remainingCount * maximumUnits) continue;
        }
        const shortPenalty = units < 4 ? (4 - units) * 15 : 0;
        const cost = state.cost + ((units - target) ** 2) + chineseBoundaryPenalty(normalized, end) * 12 + shortPenalty;
        const candidate = { end, positionIndex, cost, previous: state };
        if (!next.has(end) || next.get(end).cost > cost) next.set(end, candidate);
      }
    }
    states = next;
  }
  let state = states.get(normalized.length);
  if (!state) return null;
  const chunks = [];
  while (state.previous) {
    chunks.push(normalized.slice(state.previous.end, state.end).trim());
    state = state.previous;
  }
  return chunks.reverse();
}

function buildTargetTermLookup(terms) {
  const byAnchor = new Map();
  const lengths = new Set();
  for (const term of [...new Set(terms.filter(Boolean).map((value) => value.normalize('NFC')))]) {
    const characters = [...term];
    const length = Math.min(3, characters.length);
    if (length === 0) continue;
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
      const entries = lookup.byAnchor.get(characters.slice(index, index + length).join(''));
      if (entries) entries.forEach((term) => candidates.add(term));
    }
  }
  return [...candidates].filter((term) => text.includes(term));
}

function buildSourceTermLookup(forms) {
  const entries = [];
  const seen = new Set();
  for (const entry of forms) {
    const form = normalizedSourceForm(entry.form);
    const key = `${entry.caseSensitive ? '1' : '0'}:${form}`;
    if (!form || seen.has(key)) continue;
    seen.add(key);
    const tokens = [...new Set((form.match(/[\p{Letter}\p{Number}]+/gu) ?? []).map(sourceFormBucket))];
    if (form.split(/\s+/).filter(Boolean).length > 1 && tokens.length > 0) {
      entries.push({ form, caseSensitive: entry.caseSensitive, tokens });
    }
  }
  const frequencies = new Map();
  for (const entry of entries) {
    for (const token of entry.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  const byAnchor = new Map();
  for (const entry of entries) {
    const anchor = entry.tokens.reduce((best, token) => {
      if (!best) return token;
      const difference = (frequencies.get(token) ?? 0) - (frequencies.get(best) ?? 0);
      return difference < 0 || (difference === 0 && token.length > best.length) ? token : best;
    }, '');
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
    byAnchor.get(anchor).push(entry);
  }
  return byAnchor;
}

function relevantSourceTerms(lookup, text) {
  const normalized = text.normalize('NFKC');
  const candidates = new Set();
  for (const token of new Set((normalized.match(/[\p{Letter}\p{Number}]+/gu) ?? []).map(sourceFormBucket))) {
    const entries = lookup.get(token);
    if (entries) entries.forEach((entry) => candidates.add(entry));
  }
  return [...candidates].filter((entry) => sourceTermPattern(entry.form, entry.caseSensitive).test(normalized));
}

function protectedEnglishCuts(words, sourceTerms) {
  const normalizedWords = words.map((word) => word.normalize('NFKC'));
  const text = normalizedWords.join(' ');
  const cutOffsets = new Map();
  let offset = 0;
  for (let cut = 1; cut < words.length; cut += 1) {
    offset += normalizedWords[cut - 1].length + (cut > 1 ? 1 : 0);
    cutOffsets.set(cut, offset);
  }
  const cuts = new Set();
  for (const entry of sourceTerms) {
    const pattern = sourceTermPattern(entry.form, entry.caseSensitive);
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index + match[1].length;
      const end = match.index + match[0].length;
      for (const [cut, offset] of cutOffsets) {
        if (start < offset && offset < end) cuts.add(cut);
      }
    }
  }
  return cuts;
}

function partitionEnglish(text, count, sourceTerms, maximumCharacters) {
  const words = normalizeSubtitleText(text).split(/\s+/).filter(Boolean);
  if (count === 1) return words.join(' ').length <= maximumCharacters ? [words.join(' ')] : null;
  if (words.length < count) return null;
  const protectedCuts = protectedEnglishCuts(words, sourceTerms);
  const target = words.join(' ').length / count;
  let states = new Map([['0:0', { used: 0, end: 0, cost: 0, chunks: [] }]]);
  for (let used = 0; used < count; used += 1) {
    const next = new Map();
    for (const state of states.values()) {
      const remainingCount = count - used - 1;
      for (let end = state.end + 1; end <= words.length; end += 1) {
        if (end < words.length && protectedCuts.has(end)) continue;
        const chunk = words.slice(state.end, end).join(' ');
        if (chunk.length > maximumCharacters) break;
        if (remainingCount === 0 && end !== words.length) continue;
        if (remainingCount > 0 && words.length - end < remainingCount) continue;
        const punctuationBonus = /[.!?,;:]$/.test(words[end - 1]) ? -12 : 0;
        const cost = state.cost + ((chunk.length - target) ** 2) + punctuationBonus;
        const key = `${used + 1}:${end}`;
        const candidate = { used: used + 1, end, cost, chunks: [...state.chunks, chunk] };
        if (!next.has(key) || next.get(key).cost > cost) next.set(key, candidate);
      }
    }
    states = next;
  }
  return states.get(`${count}:${words.length}`)?.chunks ?? null;
}

function allocateWindows(start, end, zhChunks, enChunks, minimumDuration) {
  const duration = end - start;
  if (duration < minimumDuration * zhChunks.length) {
    throw new UserError(`Cannot split ${duration.toFixed(3)}s into ${zhChunks.length} readable cues of at least ${minimumDuration}s`);
  }
  const weights = zhChunks.map((chunk, index) => Math.max(displayUnits(chunk), (enChunks[index]?.length ?? 0) / 2, 1));
  const remainingAfterMinimum = duration - minimumDuration * weights.length;
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const durations = weights.map((weight) => minimumDuration + remainingAfterMinimum * weight / totalWeight);
  const windows = [];
  let cursor = start;
  durations.forEach((value, index) => {
    const next = index === durations.length - 1 ? end : cursor + value;
    windows.push([cursor, next]);
    cursor = next;
  });
  return windows;
}

function aligned(sourceCues, zhCues) {
  if (sourceCues.length !== zhCues.length) {
    throw new UserError(`Semantic translation must keep source cue count (${sourceCues.length}); found ${zhCues.length}`);
  }
  sourceCues.forEach((source, index) => {
    const translated = zhCues[index];
    if (Math.abs(source.start - translated.start) > 0.002 || Math.abs(source.end - translated.end) > 0.002) {
      throw new UserError(`Semantic Chinese cue ${index + 1} must keep the source timestamp`);
    }
  });
}

export function createReadableLayers({
  sourceCues,
  semanticZhCues,
  glossaryTerms = [],
  localDecisions = [],
  bilingualAss = false,
  maximumZhUnits = 24,
  maximumEnglishCharacters = 84,
  minimumDuration = 0.45,
}) {
  aligned(sourceCues, semanticZhCues);
  const targetTerms = [
    ...glossaryTerms.map((term) => term.zhHans),
    ...localDecisions.filter((term) => term.approvalStatus === 'approved').map((term) => term.zhHans),
  ].filter(Boolean);
  const sourceTerms = [
    ...glossaryTerms,
    ...localDecisions.filter((term) => term.approvalStatus === 'approved'),
  ].flatMap((term) => [term.en, ...(term.aliases ?? [])]
    .filter(Boolean)
    .map((form) => ({ form, caseSensitive: term.caseSensitive ?? defaultCaseSensitive(term.en) })));
  const targetTermLookup = buildTargetTermLookup(targetTerms);
  const sourceTermLookup = buildSourceTermLookup(sourceTerms);
  const readableZh = [];
  const readableEn = [];
  const warnings = [];
  for (let index = 0; index < sourceCues.length; index += 1) {
    const source = sourceCues[index];
    const translated = semanticZhCues[index];
    if (source.text.length > 4000 || translated.text.length > 4000) {
      throw new UserError(`Cue ${index + 1} exceeds the readable-layout limit of 4,000 characters`);
    }
    const zhText = normalizeSubtitleText(translated.text);
    const enText = normalizeSubtitleText(source.text);
    const zhCount = Math.max(1, Math.ceil(displayUnits(zhText) / maximumZhUnits));
    const enCount = bilingualAss ? Math.max(1, Math.ceil(enText.length / maximumEnglishCharacters)) : 1;
    const count = Math.max(zhCount, enCount);
    const protectedTargetTerms = count === 1 ? [] : relevantTargetTerms(targetTermLookup, zhText.normalize('NFC'));
    const protectedSourceTerms = count === 1 ? [] : relevantSourceTerms(sourceTermLookup, enText);
    const zhChunks = partitionChinese(zhText, count, protectedTargetTerms, maximumZhUnits);
    if (!zhChunks) {
      throw new UserError(`Chinese cue ${index + 1} cannot be split at a safe semantic boundary. Rewrite redundant phrasing without losing meaning.`);
    }
    let enChunks = count === 1 ? [enText] : partitionEnglish(enText, count, protectedSourceTerms, maximumEnglishCharacters);
    if (!enChunks) {
      if (!bilingualAss) enChunks = Array(count).fill(enText);
      else throw new UserError(`English cue ${index + 1} cannot be aligned into ${count} single-line ASS segments without breaking a protected term.`);
    }
    const windows = allocateWindows(source.start, source.end, zhChunks, enChunks, minimumDuration);
    zhChunks.forEach((text, chunkIndex) => {
      const [start, end] = windows[chunkIndex];
      readableZh.push({ index: readableZh.length + 1, start, end, text, sourceIndex: index + 1 });
      readableEn.push({ index: readableEn.length + 1, start, end, text: enChunks[chunkIndex], sourceIndex: index + 1 });
    });
  }
  return { readableZh, readableEn, warnings };
}
