# Sourced Wiki explanations

Optional research output, not another task or evidence channel. Use only when an
explanation connecting recorded material is worth retaining. Existing records
already have automatic pages; do not rewrite them as notes after every Step.

Read `wiki.indexFile` with existing read to find current pages, sources and review
warnings. Keep original observations in artifacts and commit them as usual.
Never submit a Wiki page as original evidence or use its text to bypass a review.

Add optional `wikiPages` to the existing Execute final JSON or checkpoint's
`execution` object:

```json
{
  "summary": "Retain the explanation of the observed boundary",
  "result": "no_progress",
  "wikiPages": [{
    "id": "WK-export-flow",
    "title": "Export flow and the remaining download prerequisite",
    "blocks": [{
      "id": "B-submit",
      "title": "What the submission establishes",
      "text": "The recorded submission returned a task identifier. It does not establish that downloading another account's report succeeded; consumer authorization remains unverified.",
      "sources": [{"kind": "fact", "id": "COPY_COMMITTED_FACT_ID"}]
    }]
  }]
}
```

The example is fictional; use actual sources and observations. Page IDs start
with `WK-`, block IDs with `B-`, followed by lowercase ASCII letters/digits,
underscores or hyphens. Keep IDs when renaming or revising. Block IDs are unique
within a page. A full page replaces its previous title and blocks; include every
block you intend to retain. Previous author versions remain as history.

Each block states a complete judgment with scope, conditions, supporting sources,
counterevidence or uncertainty, and the remaining gap where relevant. One or more
explicit sources are required. Source kinds: goal, step, fact, finding, evidence,
attempt. IDs must belong to this task; fact/evidence sources can also use refs
created in the same submitted batch. A Finding source uses its committed ID,
not its key; use IDs returned by the checkpoint for subsequent batches.

Do not include runtime state, private conversations, credentials or invented
conditions. Sourcing an explanation does not validate its meaning. Goals or
unfinished Steps can support a planning explanation, not a claim of observed
impact. No automatic CVSS, rating, completion or experiment progress comes from
writing or revising a page.

The Store records the current source basis, validates references and verifies
referenced evidence archives. Recorded source changes subsequently produce
review-required warnings while retaining your text. Read the changed sources
and submit the full page explicitly after reevaluation. The same text may be
retained if still justified; merely reading, renaming a Markdown file, or restarting
does not acknowledge a change. Source equality does not prove current file
integrity or that a conclusion is true. Ordinary chat does not use this feature.
