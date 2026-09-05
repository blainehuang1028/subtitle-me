import { extname } from 'node:path';
import { readJson, readUtf8, UserError } from './common.mjs';

const SRT_TIME_RE = /^(?:(?<hours>\d{1,3}):)?(?<minutes>\d{1,2}):(?<seconds>\d{1,2})[,.](?<milliseconds>\d{1,3})$/;
const ASS_TIME_RE = /^(?<hours>\d{1,2}):(?<minutes>\d{2}):(?<seconds>\d{2})[.](?<centiseconds>\d{2})$/;
const TIMELINE_LINE_RE = /^\s*(?:\d{1,3}:)?\d{1,2}:\d{1,2}[,.]\d{1,3}\s*-->/;
const TIMESTAMP_SOURCE = '(?:(?:\\d{1,3}):)?\\d{1,2}:\\d{1,2}[,.]\\d{1,3}';
const SRT_COORDINATES_SOURCE = '(?:\\s+X1:\\d+\\s+X2:\\d+\\s+Y1:\\d+\\s+Y2:\\d+)?';
const SRT_TIMELINE_RE = new RegExp(`^\\s*(${TIMESTAMP_SOURCE})\\s*-->\\s*(${TIMESTAMP_SOURCE})${SRT_COORDINATES_SOURCE}\\s*$`);
const VTT_TIMELINE_RE = new RegExp(`^\\s*(${TIMESTAMP_SOURCE})\\s*-->\\s*(${TIMESTAMP_SOURCE})(?:\\s+[A-Za-z][\\w-]*:\\S+)*\\s*$`);
const MAX_SRT_MILLISECONDS = 3_599_999_999;

export function normalizeSubtitleText(text, { preserveLines = false } = {}) {
  const normalized = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replaceAll('\u00A0', ' ')
    .replaceAll('\u2060', ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:i|b|u|s|font|lang|ruby|rt|v(?:\s+[^>]*)?|c(?:\.[\w-]+)*)(?:\s+[^>]*)?>/gi, '')
    .replace(/<\d{1,3}:\d{2}(?::\d{2})?[.,]\d{3}>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n+ */g, preserveLines ? '\n' : ' ')
    .trim();
  return preserveLines ? normalized : normalized.replace(/\s+/g, ' ').trim();
}

export function parseTimestamp(raw) {
  const match = SRT_TIME_RE.exec(String(raw).trim());
  if (!match) throw new UserError(`Invalid subtitle timestamp: ${raw}`);
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes);
  const seconds = Number(match.groups.seconds);
  const milliseconds = Number(match.groups.milliseconds.padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) throw new UserError(`Invalid subtitle timestamp: ${raw}`);
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

export function formatSrtTimestamp(seconds) {
  const total = Math.round(Number(seconds) * 1000);
  if (!Number.isFinite(total) || total < 0 || total > MAX_SRT_MILLISECONDS) {
    throw new UserError(`SRT timestamp is outside 00:00:00,000 through 999:59:59,999: ${seconds}`);
  }
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const milliseconds = total % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

export function formatAssTimestamp(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(total / 360_000);
  const minutes = Math.floor((total % 360_000) / 6000);
  const secs = Math.floor((total % 6000) / 100);
  const centiseconds = total % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function parseTimeline(raw, format) {
  const value = String(raw);
  const arrowCount = value.split('-->').length - 1;
  const match = arrowCount === 1 ? (format === 'vtt' ? VTT_TIMELINE_RE : SRT_TIMELINE_RE).exec(value) : null;
  if (!match) throw new UserError(`Invalid ${format === 'vtt' ? 'WebVTT' : 'SRT'} timeline: ${raw}`);
  return {
    start: parseTimestamp(match[1]),
    end: parseTimestamp(match[2]),
  };
}

function cue(index, start, end, text, sourceIndex = index) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new UserError(`Cue ${sourceIndex} has a non-positive duration`);
  }
  const normalized = normalizeSubtitleText(text, { preserveLines: true });
  if (!normalized) throw new UserError(`Cue ${sourceIndex} has no text`);
  return { index, start, end, text: normalized, sourceIndex };
}

export function parseSrt(raw) {
  const blocks = String(raw).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split(/\n\s*\n/).filter((block) => block.trim());
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    const timelineIndex = TIMELINE_LINE_RE.test(lines[0] ?? '')
      ? 0
      : (/^\d+$/.test(lines[0]?.trim() ?? '') && TIMELINE_LINE_RE.test(lines[1] ?? '') ? 1 : -1);
    if (timelineIndex < 0) throw new UserError(`Malformed SRT block without a timeline: ${lines[0]?.trim() || '(empty)'}`);
    if (lines.slice(timelineIndex + 1).some((line) => TIMELINE_LINE_RE.test(line))) {
      throw new UserError(`Malformed SRT block with multiple timelines near cue ${cues.length + 1}; cues must be separated by a blank line`);
    }
    const { start, end } = parseTimeline(lines[timelineIndex], 'srt');
    const rawIndex = timelineIndex > 0 && /^\d+$/.test(lines[timelineIndex - 1].trim())
      ? Number(lines[timelineIndex - 1].trim())
      : cues.length + 1;
    cues.push(cue(cues.length + 1, start, end, lines.slice(timelineIndex + 1).join('\n'), rawIndex));
  }
  if (cues.length === 0) throw new UserError('No timed subtitle cues were found');
  return cues;
}

function decodeVttCharacterReferences(text) {
  const values = { amp: '&', lt: '<', gt: '>', lrm: '\u200E', rlm: '\u200F', nbsp: '\u00A0' };
  return String(text).replace(/&(amp|lt|gt|lrm|rlm|nbsp);/g, (_, name) => values[name]);
}

export function parseVtt(raw) {
  const clean = String(raw).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const blocks = clean.split(/\n\s*\n/).filter((block) => block.trim());
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0]?.trim() ?? '')) {
      if (lines.some((line) => TIMELINE_LINE_RE.test(line))) {
        throw new UserError(`Malformed WebVTT block: ${lines[0].trim()} must be separated from subtitle cues by a blank line`);
      }
      continue;
    }
    const timelineIndex = TIMELINE_LINE_RE.test(lines[0] ?? '')
      ? 0
      : (lines[0]?.trim() && TIMELINE_LINE_RE.test(lines[1] ?? '') ? 1 : -1);
    if (timelineIndex < 0) throw new UserError(`Malformed WebVTT block without a timeline: ${lines[0]?.trim() || '(empty)'}`);
    if (lines.slice(timelineIndex + 1).some((line) => TIMELINE_LINE_RE.test(line))) {
      throw new UserError(`Malformed WebVTT block with multiple timelines near cue ${cues.length + 1}; cues must be separated by a blank line`);
    }
    const { start, end } = parseTimeline(lines[timelineIndex], 'vtt');
    cues.push(cue(cues.length + 1, start, end, decodeVttCharacterReferences(lines.slice(timelineIndex + 1).join('\n'))));
  }
  if (cues.length === 0) throw new UserError('No timed WebVTT cues were found');
  return cues;
}

function parseAssTimestamp(raw) {
  const match = ASS_TIME_RE.exec(String(raw).trim());
  if (!match) throw new UserError(`Invalid ASS timestamp: ${raw}`);
  return Number(match.groups.hours) * 3600
    + Number(match.groups.minutes) * 60
    + Number(match.groups.seconds)
    + Number(match.groups.centiseconds) / 100;
}

export function parseAss(raw) {
  const lines = String(raw).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
  let inEvents = false;
  let fields = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  const cues = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[Events\]$/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(trimmed) && !/^\[Events\]$/i.test(trimmed)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(trimmed)) {
      fields = trimmed.slice(trimmed.indexOf(':') + 1).split(',').map((field) => field.trim());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(trimmed)) continue;
    const payload = trimmed.slice(trimmed.indexOf(':') + 1).trim();
    const parts = payload.split(',');
    if (parts.length < fields.length) throw new UserError(`Malformed ASS Dialogue row: expected ${fields.length} fields, found ${parts.length}`);
    const values = [...parts.slice(0, fields.length - 1), parts.slice(fields.length - 1).join(',')];
    const row = Object.fromEntries(fields.map((field, index) => [field.toLowerCase(), values[index]?.trim() ?? '']));
    const text = row.text
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ');
    cues.push(cue(cues.length + 1, parseAssTimestamp(row.start), parseAssTimestamp(row.end), text));
  }
  if (cues.length === 0) throw new UserError('No Dialogue events were found in the ASS file');
  return cues;
}

function textOfTokens(tokens) {
  return tokens.map((token) => token.text).join(' ');
}

function splitTokenGroup(tokens, maxCharacters) {
  const chunks = [];
  const minimum = Math.max(20, Math.floor(maxCharacters * 0.35));
  const hardMaximum = Math.floor(maxCharacters * 1.2);
  const lengths = [0];
  for (const token of tokens) lengths.push(lengths.at(-1) + token.text.length);
  const segmentLength = (start, end) => lengths[end] - lengths[start] + Math.max(0, end - start - 1);
  let start = 0;
  while (segmentLength(start, tokens.length) > hardMaximum && start < tokens.length - 1) {
    let end = start + 1;
    while (end < tokens.length && segmentLength(start, end + 1) <= hardMaximum) end += 1;
    const candidates = [];
    for (let split = start + 1; split <= end; split += 1) {
      if (segmentLength(start, split) < minimum || segmentLength(split, tokens.length) < minimum) continue;
      const previous = tokens[split - 1].text.replace(/["'\u2019\u201D)\]]+$/g, '');
      const current = tokens[split]?.text.toLowerCase().replace(/^["'\u2018\u201C([]+/g, '') ?? '';
      if (/[,;:]$/.test(previous) || ['and', 'but', 'which', 'that', 'because', 'so', 'while', 'where', 'when', 'then'].includes(current)) candidates.push(split);
    }
    const fallback = [];
    if (candidates.length === 0) {
      for (let split = start + 1; split <= end; split += 1) {
        if (segmentLength(start, split) >= minimum && segmentLength(split, tokens.length) >= minimum) fallback.push(split);
      }
    }
    const usable = candidates.length > 0 ? candidates : fallback;
    const splitAt = usable.length > 0
      ? usable.reduce((best, value) => Math.abs(segmentLength(start, value) - maxCharacters) < Math.abs(segmentLength(start, best) - maxCharacters) ? value : best)
      : end;
    chunks.push(tokens.slice(start, splitAt));
    start = splitAt;
  }
  if (start < tokens.length) chunks.push(tokens.slice(start));
  return chunks;
}

export function parseJson3(data, { maxCharacters = 92, maxDuration = 7.5 } = {}) {
  const rawEvents = [];
  for (const [sourceOrder, event] of (Array.isArray(data?.events) ? data.events : []).entries()) {
    if (!event || typeof event !== 'object' || !Array.isArray(event.segs)) continue;
    if (event.segs.some((segment) => segment?.utf8 !== undefined && typeof segment.utf8 !== 'string')) {
      throw new UserError(`JSON3 event ${sourceOrder + 1} has a non-text utf8 segment`);
    }
    const text = normalizeSubtitleText(event.segs.map((segment) => segment?.utf8 ?? '').join(''));
    if (!text) continue;
    if (typeof event.tStartMs !== 'number') {
      throw new UserError(`JSON3 text event ${sourceOrder + 1} requires tStartMs`);
    }
    const startMilliseconds = event.tStartMs;
    if (!Number.isFinite(startMilliseconds) || startMilliseconds < 0 || Math.round(startMilliseconds) > MAX_SRT_MILLISECONDS) {
      throw new UserError(`JSON3 text event ${sourceOrder + 1} has an invalid or unsupported tStartMs`);
    }
    let declaredDuration = null;
    if (event.dDurationMs !== undefined && event.dDurationMs !== null) {
      if (typeof event.dDurationMs !== 'number') {
        throw new UserError(`JSON3 text event ${sourceOrder + 1} has an invalid dDurationMs`);
      }
      declaredDuration = event.dDurationMs;
      if (!Number.isFinite(declaredDuration) || declaredDuration <= 0) {
        throw new UserError(`JSON3 text event ${sourceOrder + 1} has an invalid dDurationMs`);
      }
    }
    rawEvents.push({ sourceOrder, start: startMilliseconds / 1000, declaredDuration, text });
  }
  rawEvents.sort((a, b) => a.start - b.start || a.sourceOrder - b.sourceOrder);
  if (rawEvents.length === 0) throw new UserError('No caption events were found in the JSON3 file');
  const cues = [];
  rawEvents.forEach(({ start, declaredDuration, text, sourceOrder }, eventIndex) => {
    const nextStart = rawEvents[eventIndex + 1]?.start;
    const end = declaredDuration !== null
      ? start + declaredDuration / 1000
      : nextStart !== undefined && nextStart > start ? nextStart : start + 2;
    const words = text.match(/\S+/g) ?? [];
    const startRounded = Math.round(start * 1000);
    const endRounded = Math.round(end * 1000);
    if (!Number.isFinite(end) || endRounded <= startRounded || endRounded > MAX_SRT_MILLISECONDS) {
      throw new UserError(`JSON3 text event ${sourceOrder + 1} has an invalid or unsupported end time`);
    }
    const weights = words.map((word) => Math.max([...word].length, 1));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let cursor = start;
    const tokens = words.map((word, index) => {
      const tokenEnd = index === words.length - 1 ? end : cursor + (end - start) * weights[index] / totalWeight;
      const token = { text: word, start: cursor, end: tokenEnd };
      cursor = tokenEnd;
      return token;
    });
    const durationAdjustedMaximum = end - start > maxDuration
      ? Math.max(20, Math.min(maxCharacters, Math.ceil(text.length * maxDuration / (end - start))))
      : maxCharacters;
    const groups = splitTokenGroup(tokens, durationAdjustedMaximum);
    groups.forEach((group) => {
      cues.push(cue(cues.length + 1, group[0].start, group.at(-1).end, textOfTokens(group)));
    });
  });
  if (cues.length === 0) throw new UserError('No caption tokens were found in the JSON3 file');
  return cues;
}

export function writeSrt(cues) {
  return `${cues.map((item, index) => [
    String(index + 1),
    `${formatSrtTimestamp(item.start)} --> ${formatSrtTimestamp(item.end)}`,
    normalizeSubtitleText(item.text, { preserveLines: true }),
  ].join('\n')).join('\n\n')}\n`;
}

export async function parseSubtitleFile(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.srt') return { format: 'srt', cues: parseSrt(await readUtf8(path)), warnings: [] };
  if (extension === '.vtt') return { format: 'vtt', cues: parseVtt(await readUtf8(path)), warnings: [] };
  if (extension === '.json' || extension === '.json3') return { format: 'json3', cues: parseJson3(await readJson(path)), warnings: [] };
  if (extension === '.ass' || extension === '.ssa') {
    return {
      format: 'ass',
      cues: parseAss(await readUtf8(path)),
      warnings: ['ASS dialogue was extracted and normalized. Original styles, positioning, and effects are not preserved.'],
    };
  }
  throw new UserError(`Unsupported subtitle format ${extension || '(none)'}. Provide SRT, VTT, JSON3, or ASS.`);
}

export function cueTextForComparison(text) {
  return normalizeSubtitleText(text).replace(/\s+/g, '');
}

export function displayUnits(text) {
  let total = 0;
  for (const character of [...String(text)]) {
    if (/\p{Mark}/u.test(character)) continue;
    if (/\s/u.test(character)) total += 0.5;
    else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\u3000-\u303F\uFF01-\uFF60“”‘’…]/u.test(character)) total += 1;
    else total += 0.5;
  }
  return total;
}

export function findTimelineIssues(cues) {
  const issues = [];
  cues.forEach((item, index) => {
    if (item.end <= item.start) issues.push({ code: 'non_positive_duration', cue: index + 1 });
    const previous = cues[index - 1];
    if (previous && item.start < previous.start) issues.push({ code: 'out_of_order', cue: index + 1 });
    if (previous && item.start < previous.end - 0.002) {
      issues.push({ code: 'source_overlap', cue: index + 1, overlapSeconds: Number((previous.end - item.start).toFixed(3)) });
    }
  });
  return issues;
}
