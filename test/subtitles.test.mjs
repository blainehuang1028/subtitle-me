import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  displayUnits,
  normalizeSubtitleText,
  parseAss,
  parseJson3,
  parseSubtitleFile,
  parseSrt,
  parseVtt,
  writeSrt,
} from '../skills/subtitle-me/scripts/lib/subtitles.mjs';

test('parses and rewrites SRT timestamps without drift', () => {
  const input = '1\n00:00:01,250 --> 00:00:03,500\nHello world.\n';
  const cues = parseSrt(input);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1.25);
  assert.equal(writeSrt(cues), input);
});

test('accepts the complete SubRip coordinate extension', () => {
  const cues = parseSrt('1\n00:00:01,250 --> 00:00:03,500 X1:0 X2:1920 Y1:0 Y2:1080\nHello world.\n');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].end, 3.5);
});

test('rejects adjacent SRT cues without the required blank separator', () => {
  assert.throws(
    () => parseSrt('1\n00:00:00,000 --> 00:00:01,000\nFirst.\n2\n00:00:01,000 --> 00:00:02,000\nSecond.\n'),
    /multiple timelines/,
  );
});

test('rejects discarded prefix lines before SRT and WebVTT timelines', () => {
  assert.throws(
    () => parseSrt('1\nDROPPED\n00:00:00,000 --> 00:00:01,000\nVisible.\n'),
    /Malformed SRT block/,
  );
  assert.throws(
    () => parseVtt('WEBVTT\n\nidentifier\nDROPPED\n00:00:00.000 --> 00:00:01.000\nVisible.\n'),
    /Malformed WebVTT block/,
  );
});

test('rejects timelines with multiple arrows or trailing garbage', () => {
  assert.throws(
    () => parseSrt('1\n00:00:00,000 --> 00:00:01,000 --> 00:00:02,000\nBroken.\n'),
    /Invalid SRT timeline/,
  );
  assert.throws(
    () => parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000 garbage\nBroken.\n'),
    /Invalid WebVTT timeline/,
  );
});

test('preserves a literal arrow that is not a timeline', () => {
  const cues = parseSrt('1\n00:00:00,000 --> 00:00:01,000\nMove A --> B.\n');
  assert.equal(cues[0].text, 'Move A --> B.');
});

test('parses WebVTT cue identifiers and settings', () => {
  const cues = parseVtt('WEBVTT\n\nintro\n00:01.000 --> 00:03.000 align:start\nHello <i>world</i>.\n');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Hello world.');
});

test('decodes standard WebVTT character references once', () => {
  const cues = parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFish &amp; chips &lt;3 &amp;lt;\n');
  assert.equal(cues[0].text, 'Fish & chips <3 &lt;');
});

test('rejects adjacent WebVTT cues without the required blank separator', () => {
  assert.throws(
    () => parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFirst.\n00:00:01.000 --> 00:00:02.000\nSecond.\n'),
    /multiple timelines/,
  );
});

test('rejects timelines swallowed by WebVTT header or directive blocks', () => {
  for (const directive of ['WEBVTT', 'NOTE missing separator', 'STYLE', 'REGION']) {
    assert.throws(
      () => parseVtt(`${directive}\n00:00:00.000 --> 00:00:01.000\nDropped.\n\n00:00:01.000 --> 00:00:02.000\nKept.\n`),
      /must be separated/,
    );
  }
});

test('extracts ASS dialogue and discards styling', () => {
  const raw = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Hello\\Nworld\n';
  const cues = parseAss(raw);
  assert.equal(cues[0].text, 'Hello\nworld');
});

test('converts JSON3 word segments into ordered cues', () => {
  const cues = parseJson3({
    events: [
      { tStartMs: 0, segs: [{ utf8: 'Hello', tOffsetMs: 0 }, { utf8: ' world.', tOffsetMs: 500 }] },
      { tStartMs: 1500, segs: [{ utf8: 'Next sentence.', tOffsetMs: 0 }] },
    ],
  });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello world.');
  assert.equal(cues[1].text, 'Next sentence.');
});

test('splits a large JSON3 event without cubic slowdown', () => {
  const words = Array.from({ length: 1500 }, (_, index) => index % 12 === 11 ? 'boundary,' : 'word').join(' ');
  const started = Date.now();
  const cues = parseJson3({ events: [{ tStartMs: 0, dDurationMs: 120000, segs: [{ utf8: words }] }] });
  assert.ok(cues.length > 1);
  assert.ok(Date.now() - started < 3000);
});

test('preserves each JSON3 event outer duration and treats word joiners as spaces', () => {
  const cues = parseJson3({
    events: [{ tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: 'Hello\u2060world.' }] }],
  });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 6);
  assert.equal(cues[0].text, 'Hello world.');
});

test('fails closed on invalid or unsupported JSON3 text-event timing', () => {
  for (const event of [
    { segs: [{ utf8: 'Missing start.' }] },
    { tStartMs: 'invalid', segs: [{ utf8: 'Invalid start.' }] },
    { tStartMs: -1, segs: [{ utf8: 'Negative start.' }] },
    { tStartMs: 3_600_000_000, segs: [{ utf8: 'Too late.' }] },
    { tStartMs: 0, dDurationMs: -1, segs: [{ utf8: 'Invalid duration.' }] },
    { tStartMs: 3_599_999_000, dDurationMs: 2_000, segs: [{ utf8: 'End is too late.' }] },
  ]) {
    assert.throws(() => parseJson3({ events: [event] }), /JSON3 text event/);
  }
  const cues = parseJson3({ events: [
    { tStartMs: 'invalid', segs: [] },
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Valid caption.' }] },
  ] });
  assert.equal(cues.length, 1);
  assert.throws(() => writeSrt([{ index: 1, start: -1, end: 1, text: 'Invalid.' }]), /outside/);
});

test('keeps literal angle-bracket speech while stripping known subtitle markup', () => {
  assert.equal(normalizeSubtitleText('1 < 2 and <i>three</i> > 2'), '1 < 2 and three > 2');
});

test('fails closed on malformed timed blocks and ASS rows', () => {
  assert.throws(() => parseSrt('1\n00:00:00,000 --> 00:00:01,000\nFine.\n\nnot a cue\n'), /Malformed SRT block/);
  assert.throws(() => parseVtt('WEBVTT\n\n00:00.000 --> 00:01.000\nFine.\n\nbroken\n'), /Malformed WebVTT block/);
  assert.throws(() => parseAss('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00\n'), /Malformed ASS Dialogue/);
});

test('reads UTF-16LE and UTF-16BE subtitle files with BOMs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subtitle-me-utf16-'));
  const text = '1\n00:00:01,000 --> 00:00:02,000\nHello.\n';
  const le = join(directory, 'le.srt');
  const be = join(directory, 'be.srt');
  await writeFile(le, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]));
  const beBody = Buffer.from(text, 'utf16le');
  beBody.swap16();
  await writeFile(be, Buffer.concat([Buffer.from([0xFE, 0xFF]), beBody]));
  assert.equal((await parseSubtitleFile(le)).cues[0].text, 'Hello.');
  assert.equal((await parseSubtitleFile(be)).cues[0].text, 'Hello.');
});

test('rejects truncated UTF-16LE and UTF-16BE input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subtitle-me-truncated-utf16-'));
  for (const [name, bom] of [['le', [0xFF, 0xFE]], ['be', [0xFE, 0xFF]]]) {
    const input = join(directory, `${name}.srt`);
    await writeFile(input, Buffer.from([...bom, 0x41]));
    await assert.rejects(() => parseSubtitleFile(input), /odd byte count/);
  }
});

test('rejects invalid UTF-8 instead of replacing bytes silently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subtitle-me-invalid-utf8-'));
  const input = join(directory, 'windows-1252.srt');
  await writeFile(input, Buffer.concat([
    Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCaf'),
    Buffer.from([0xE9]),
    Buffer.from('.\n'),
  ]));
  await assert.rejects(() => parseSubtitleFile(input), /valid UTF-8/);
});

test('counts Chinese display units more heavily than Latin text', () => {
  assert.equal(displayUnits('中文字幕'), 4);
  assert.equal(displayUnits('AI 25'), 2.5);
});
