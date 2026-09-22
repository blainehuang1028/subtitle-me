import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBilingualAss, buildPreviewArgs } from '../skills/subtitle-me/scripts/lib/ass.mjs';
import { createReadableLayers } from '../skills/subtitle-me/scripts/lib/readable.mjs';
import { parseSrt, writeSrt } from '../skills/subtitle-me/scripts/lib/subtitles.mjs';

test('splits long Chinese only inside the source cue span', () => {
  const source = parseSrt('1\n00:00:00,000 --> 00:00:06,000\nThis sentence has two clear parts, and both need enough time to read.\n');
  const zh = parseSrt('1\n00:00:00,000 --> 00:00:06,000\n这句话包含两个清楚的部分，两个部分都需要足够的阅读时间。\n');
  const result = createReadableLayers({ sourceCues: source, semanticZhCues: zh });
  assert.equal(result.readableZh.length, 2);
  assert.equal(result.readableZh[0].start, 0);
  assert.equal(result.readableZh.at(-1).end, 6);
  assert.equal(result.readableZh.map((cue) => cue.text).join(''), zh[0].text);
});

test('normalizes semantic line breaks to one readable Chinese row', () => {
  const source = parseSrt('1\n00:00:00,000 --> 00:00:04,000\nOne indivisible thought.\n');
  const zh = parseSrt('1\n00:00:00,000 --> 00:00:04,000\n一个不可拆开的想法\n需要保留完整语义。\n');
  const result = createReadableLayers({ sourceCues: source, semanticZhCues: zh, bilingualAss: false });
  assert.ok(result.readableZh.every(cue => !cue.text.includes('\n')));
  const bilingual = createReadableLayers({ sourceCues: source, semanticZhCues: zh, bilingualAss: true });
  assert.ok(bilingual.readableZh.every(cue => !cue.text.includes('\n')));
});

test('builds transparent-background bilingual ASS with two rows', () => {
  const zh = parseSrt('1\n00:00:00,000 --> 00:00:03,000\n你好。\n');
  const en = parseSrt('1\n00:00:00,000 --> 00:00:03,000\nHello.\n');
  const ass = buildBilingualAss({ zhCues: zh, enCues: en });
  assert.match(ass, /Style: Bilingual[^\n]*&HFF000000/);
  assert.match(ass, /你好。\\N\{\\fs32\}Hello\./);
  assert.equal(writeSrt(zh).includes('你好。'), true);
  assert.throws(() => buildBilingualAss({ zhCues: zh, enCues: en, fontName: 'Arial,100' }), /font name/);
  assert.throws(() => buildBilingualAss({ zhCues: zh, enCues: en, fontName: 'Arial\nStyle: Injected' }), /font name/);
});

test('seeks the neutral ASS preview to the requested subtitle timestamp', () => {
  const args = buildPreviewArgs({ assPath: 'demo.ass', outputPath: 'preview.png', at: 14 });
  assert.equal(args.some((value) => value.includes('color=c=#18202b:s=1920x1080:d=15')), true);
  assert.equal(args[args.indexOf('-ss') + 1], '14');
  assert.equal(args.indexOf('-ss') > args.indexOf('-i'), true);
  assert.throws(
    () => buildPreviewArgs({ assPath: 'demo.ass', outputPath: 'preview.png', at: -1 }),
    /non-negative number/,
  );
});

test('rejects a very long unsplittable Chinese cue without quadratic runaway', () => {
  const text = '这是一个没有安全断点的超长字幕'.repeat(220);
  const source = [{ index: 1, start: 0, end: 180, text: 'Long source.' }];
  const zh = [{ index: 1, start: 0, end: 180, text }];
  const started = Date.now();
  assert.throws(() => createReadableLayers({ sourceCues: source, semanticZhCues: zh }), /cannot be split/);
  assert.ok(Date.now() - started < 1500);
});

test('splits maximum-length Chinese cues without quadratic runaway', () => {
  const sourceCues = Array.from({ length: 5 }, (_, index) => ({ index: index + 1, start: index * 180, end: index * 180 + 180, text: 'Long source.' }));
  const semanticZhCues = sourceCues.map((cue) => ({ ...cue, text: '甲，'.repeat(2000) }));
  const started = Date.now();
  const result = createReadableLayers({ sourceCues, semanticZhCues });
  assert.equal(result.readableZh.length, 835);
  assert.ok(Date.now() - started < 3000);
});

test('filters unrelated terminology before readable segmentation', () => {
  const glossaryTerms = Array.from({ length: 2000 }, (_, index) => ({ en: `Product ${index}`, aliases: Array.from({ length: 32 }, (__, alias) => `P${index}-${alias}`), zhHans: `产品${index}` }));
  const sourceCues = Array.from({ length: 1000 }, (_, index) => ({ index: index + 1, start: index * 2, end: index * 2 + 2, text: 'A short sentence with two parts, and a clear ending.' }));
  const semanticZhCues = sourceCues.map((cue) => ({ ...cue, text: '这是一句简短的话，而且结尾很清楚。' }));
  const started = Date.now();
  const result = createReadableLayers({ sourceCues, semanticZhCues, glossaryTerms });
  assert.equal(result.readableZh.length, 1000);
  assert.ok(Date.now() - started < 3000);
});

test('does not split a protected non-ASCII source term', () => {
  const source = parseSrt('1\n00:00:00,000 --> 00:00:06,000\nBefore Αλφα Βητα after.\n');
  const zh = parseSrt('1\n00:00:00,000 --> 00:00:06,000\n前文之后还有足够长的内容，因此需要在安全的位置拆分字幕。\n');
  const result = createReadableLayers({
    sourceCues: source,
    semanticZhCues: zh,
    bilingualAss: true,
    glossaryTerms: [{ en: 'Αλφα Βητα', aliases: [], zhHans: '阿尔法贝塔' }],
  });
  assert.equal(result.readableEn.length, 2);
  assert.equal(result.readableEn.some((cue) => cue.text.includes('Αλφα Βητα')), true);
});

test('protects Unicode case-equivalent source terms during readable segmentation', () => {
  const source = parseSrt('1\n00:00:00,000 --> 00:00:08,000\nBefore several words ς alpha after several more words for balance.\n');
  const zh = parseSrt('1\n00:00:00,000 --> 00:00:08,000\n前文有足够多的内容，后文也有足够多的内容来平衡字幕。\n');
  const result = createReadableLayers({
    sourceCues: source,
    semanticZhCues: zh,
    bilingualAss: true,
    maximumEnglishCharacters: 24,
    glossaryTerms: [{ en: 'σ alpha', aliases: [], caseSensitive: false, zhHans: '希格玛阿尔法' }],
  });
  assert.equal(result.readableEn.length > 1, true);
  assert.equal(result.readableEn.some((cue) => cue.text.includes('ς alpha')), true);
});

test('does not split a number from its Chinese unit', () => {
  const source = [{ index: 1, start: 0, end: 8, text: 'The route is one hundred kilometers long.' }];
  const zh = [{ index: 1, start: 0, end: 8, text: '甲乙丙丁100公里，戊己庚辛' }];
  const result = createReadableLayers({ sourceCues: source, semanticZhCues: zh, maximumZhUnits: 9 });
  assert.equal(result.readableZh.length, 2);
  assert.equal(result.readableZh.some((cue, index) => /\d$/u.test(cue.text) && /^\p{Letter}/u.test(result.readableZh[index + 1]?.text ?? '')), false);
});

test('normalizes target terms and never starts a chunk with a combining mark', () => {
  const source = [{ index: 1, start: 0, end: 8, text: 'The Cafe route has two clear parts.' }];
  const zh = [{ index: 1, start: 0, end: 8, text: '甲乙丙丁Cafe\u0301，戊己庚辛壬癸' }];
  const result = createReadableLayers({
    sourceCues: source,
    semanticZhCues: zh,
    glossaryTerms: [{ en: 'Cafe', aliases: [], zhHans: 'Café' }],
    maximumZhUnits: 9,
  });
  assert.equal(result.readableZh.map((cue) => cue.text).join('').normalize('NFKC'), zh[0].text.normalize('NFKC'));
  assert.equal(result.readableZh.some((cue) => /^\p{Mark}/u.test(cue.text)), false);
  assert.equal(result.readableZh.some((cue) => cue.text.normalize('NFKC').includes('Café')), true);
});
