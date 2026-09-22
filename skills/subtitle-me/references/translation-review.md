# Translation and independent review

Read this reference while translating and before final QA.

## Semantic translation

Translate directly from `source/source.en.srt` into `subtitles/semantic.zh-Hans.srt`.

- Keep the same cue count, order, normalized 1-based cue positions, start times, and end times.
- Translate meaning rather than English word order.
- Preserve uncertainty, criticism, humor, emphasis, and speaker attitude.
- Preserve numbers, units, names, and approved terminology.
- Do not add background explanations or facts not spoken in the source.
- Keep the semantic layer layout-independent. Readability changes belong in the readable layer.

Work in batches of at most 50 cues when the subtitle is long. Include a small adjacent context window and only the terms active in that batch.

## Second AI pass

This pass is mandatory. Re-read the English and the current Chinese as a fresh comparison. Do not accept the first pass because it sounds fluent.

Check every cue for:

- changed or missing meaning;
- invented meaning;
- names and numbers;
- terminology consistency;
- untranslated English;
- natural Simplified Chinese;
- context across adjacent cue boundaries.

Run:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" review scaffold --job "$JOB_DIR"
```

The command creates a review record for the current job. Then edit `qa/ai-review.json` only after performing the review:

```json
{
  "schemaVersion": 1,
  "job": "example",
  "status": "passed",
  "reviewedAt": "2026-09-05T00:00:00.000Z",
  "coverage": [
    { "cueStart": 1, "cueEnd": 50 },
    { "cueStart": 51, "cueEnd": 84 }
  ],
  "issues": [],
  "notes": "Reviewed fidelity, names, numbers, terminology, omissions, and natural Chinese."
}
```

Every recorded issue must include `resolved: true` before the review can pass. If a fix changes the semantic translation, generate a new scaffold and review the changed result before running QA.

This evidence may be produced by the same Agent in a deliberately separate pass. A host-specific subagent is optional and must not be required for portability.

## Natural Chinese and editorial boundaries

Before translating, note audience, video type, tone and source context in a short job brief. Read [translation-quality.md](translation-quality.md) for examples and exceptions. Preserve actual contrasts and inferences; phrases such as “这意味着” or “不是……而是……” are contextual review signals, never forbidden strings. Keep uncertainty, negation, numbers and joke callbacks intact. A Chinese meme may replace a joke only when its meaning, tone and reference function match.

## Review after an edit

New scaffolds include visible `batches` with text snapshots and one neighboring cue on each side. Unchanged passed ranges are restored to `coverage`; review ranges with `reused: false`, then add their coverage and set the final status and timestamp. Do not replace or remove the `batches` field. QA compares snapshots against current inputs. Changing a sentence also invalidates a neighboring batch when its context includes that sentence. Relevant terminology changes conservatively invalidate all batches; unrelated glossary entries and extraction timestamps do not. Old reports without snapshots, or reports containing issue records, receive a full new review. Existing legacy reports remain readable but cannot provide incremental reuse.

Readable-layer regeneration resets the overall review to pending but retains the preceding record for reuse. Source refresh deliberately requires fresh terminology work. Title, description and ASS style changes need final QA, not a new semantic review. Deterministic QA still runs on the small text artifacts; this public skill does not read or hash full videos during delivery.
