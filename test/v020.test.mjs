import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runNeutralSmoke } from '../scripts/smoke-cli.mjs';
import { initializeJob, jobArtifactPaths } from '../skills/subtitle-me/scripts/lib/jobs.mjs';
import { createAiReviewScaffold, runQa } from '../skills/subtitle-me/scripts/lib/qa.mjs';
import { writeSrt } from '../skills/subtitle-me/scripts/lib/subtitles.mjs';
const cli = resolve('skills/subtitle-me/scripts/subtitle-me.mjs');
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const save = (p, data) => writeFile(p, JSON.stringify(data));
function run(args) { const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); return r.stdout; }

test('review snapshots reuse unchanged ranges, include neighbors and reject edits after review', async () => {
  const project = await mkdtemp(join(tmpdir(),'subtitle-review-'));
  const input = join(project,'input.srt');
  const cues = Array.from({length:60},(_,i)=>({index:i+1,start:i*3,end:i*3+3,text:'We can go.'}));
  await writeFile(input,writeSrt(cues));
  const {jobPath,job}=await initializeJob({projectRoot:project,inputPath:input,requestedId:'sample'});
  const p=jobArtifactPaths(jobPath), glossaryPath=join(project,'subtitle-localizer/glossary.json');
  const zh=writeSrt(cues.map(c=>({...c,text:'可以出发了。'})));
  await writeFile(p.semanticZh,zh); await writeFile(p.readableZh,zh);
  for(const path of [p.termCandidates,p.termDecisions]) await save(path,{schemaVersion:1,job:job.id,completed:true,terms:[]});
  let review=await createAiReviewScaffold({jobPath,glossaryPath});
  assert.deepEqual(review.batches.map(b=>b.reused),[false,false,false]);
  review.status='passed';review.reviewedAt=new Date().toISOString();review.coverage=[{cueStart:1,cueEnd:60}];await save(p.aiReview,review);
  const unchanged=await createAiReviewScaffold({jobPath,glossaryPath});assert.ok(unchanged.batches.every(b=>b.reused));
  await save(p.aiReview,review);
  const glossary=await json(glossaryPath);glossary.revision+=1;glossary.terms.push({id:'unrelated',en:'UnrelatedName',zhHans:'无关名字',aliases:[],approvalStatus:'approved',syncScope:'project'});await save(glossaryPath,glossary);
  assert.ok((await createAiReviewScaffold({jobPath,glossaryPath})).batches.every(b=>b.reused));
  await save(p.aiReview,review);
  const edited=cues.map((c,i)=>({...c,text:i===24?'我们可以出发了。':'可以出发了。'}));
  await writeFile(p.semanticZh,writeSrt(edited));await writeFile(p.readableZh,writeSrt(edited));
  const stale=await runQa({jobPath,job,glossaryPath});assert.ok(stale.errors.some(e=>e.code==='ai_review_stale'));
  const changed=await createAiReviewScaffold({jobPath,glossaryPath});assert.deepEqual(changed.batches.map(b=>b.reused),[false,false,true]);
  glossary.terms.push({id:'relevant',en:'go',zhHans:'出发',aliases:[],approvalStatus:'approved',syncScope:'project'});await save(glossaryPath,glossary);
  assert.ok((await createAiReviewScaffold({jobPath,glossaryPath})).batches.every(b=>!b.reused));
});

test('single-language ASS passes CLI QA and excludes the other presentation row', async () => {
  const {job}=await runNeutralSmoke();
  for(const language of ['zh','en','bilingual']) {
    run(['ass','build','--job',job,'--language',language]);
    const ass=await readFile(join(job,'subtitles/bilingual.zh-en.ass'),'utf8');
    const rows=ass.split('\n').filter(line=>line.startsWith('Dialogue:'));
    assert.ok(rows.every(row=>(row.match(/\\N/g)??[]).length===(language==='bilingual'?1:0)));
    run(['qa','--job',job]);
  }
});

test('description requires summary, attribution and source; changing it does not reset review', async () => {
  const {job,project}=await runNeutralSmoke();
  const before=await readFile(join(job,'qa/ai-review.json'),'utf8');
  run(['init','--input',join(project,'demo.en.srt'),'--project',project,'--job','demo','--description','yes']);
  const bad=spawnSync(process.execPath,[cli,'qa','--job',job],{encoding:'utf8'});assert.notEqual(bad.status,0);
  await writeFile(join(job,'description.zh-Hans.md'),'# 视频简介\n\n介绍专注模式。\n来源：https://example.com/original\n作者：Example Creator\n');
  run(['qa','--job',job]);
  assert.equal(await readFile(join(job,'qa/ai-review.json'),'utf8'),before);
});
