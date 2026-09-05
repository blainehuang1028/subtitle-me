# Terminology governance

Read this reference before extracting or applying terms.

## What belongs in the terminology pass

Extract only wording whose consistency matters across cues or future work:

- people, organizations, places, brands, and fictional names;
- named product features, interface labels, titles, and domain concepts;
- recurring source forms that could reasonably receive competing Chinese translations.

Do not turn ordinary vocabulary, full sentences, or every capitalized word into a term.

Existing approved project terms are binding whenever context matches. A context-specific choice may stay scoped to one job. Ambiguous new terms must be asked in one batch. Translation may proceed with a clearly marked provisional choice, but final QA fails until every extracted candidate has a completed decision.

## Candidate file

Write `qa/term-candidates.json`:

```json
{
  "schemaVersion": 1,
  "job": "example",
  "completed": true,
  "updatedAt": "2026-09-05T00:00:00.000Z",
  "terms": [
    {
      "en": "Focus Mode",
      "aliases": [],
      "caseSensitive": true,
      "category": "feature",
      "cueIndexes": [2, 19],
      "reason": "A recurring named feature."
    }
  ]
}
```

An empty candidate pass is valid only when `completed` is true and the model actually inspected the source.

## Decision file

Write `qa/term-decisions.json`:

```json
{
  "schemaVersion": 1,
  "job": "example",
  "completed": true,
  "updatedAt": "2026-09-05T00:00:00.000Z",
  "terms": [
    {
      "en": "Focus Mode",
      "aliases": [],
      "caseSensitive": true,
      "zhHans": "专注模式",
      "category": "feature",
      "approvalStatus": "approved",
      "syncScope": "project",
      "status": "user-approved",
      "rationale": "Use this label across the current project."
    }
  ]
}
```

Allowed `approvalStatus` values:

- `approved`: an intentional translation exists;
- `review-required`: evidence or user choice is still missing;
- `rejected`: the candidate is not a governed term.

Allowed `syncScope` values:

- `project`: reusable in this project and eligible for `glossary.json`;
- `job`: valid only for the current subtitle job.

Only `approved` plus `project` enters the shared project glossary. Apply decisions with the CLI. It updates JSON atomically, regenerates Markdown, increments the revision, and appends a JSONL journal event.

`caseSensitive` is optional. It defaults to `true` when the English term contains an uppercase Unicode letter and `false` for all-lowercase terms. Set it explicitly for homonyms such as a proper name `May` versus the ordinary word `may`.

Never change terminology by editing `glossary.md`. Never promote a provisional or web-suggested translation without a completed decision.
