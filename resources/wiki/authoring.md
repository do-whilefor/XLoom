# Sourced Wiki explanations

Optional research output, not another task or evidence channel. Use only when an
explanation connecting recorded material is worth retaining. Existing records
already have automatic pages; do not rewrite them as notes after every Step.

Use a delivered native source package for current pages, conditions and review
warnings. Open `wiki.indexFile` only to discover missing pages or author history;
do not reopen the same complete package through index/page/record just to confirm
it exists. Wiki files are derived explanations, never archive originals.
Follow each evidence record's `originalReadPath` to inspect verified archive bytes;
`nextReadPath` continues long originals and `startReadPath` returns to earlier
omitted context. Search snippets and metadata are not full original reading.
The same-role `reading` hints identify repeated records and remaining original
bytes; they neither hide content nor acknowledge review. Fresh roles still need
their own source reading. Keep original observations in artifacts and commit them as usual.
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
within a page. A full page (title + blocks) replaces its previous title and blocks;
include every block you intend to retain. Omitted page metadata stays unchanged;
omitted block metadata/requiredBlockRefs in a full replacement is removed.
Previous author versions, including metadata and review bases, remain as history.

Each block states a complete judgment with scope, conditions, supporting sources,
counterevidence or uncertainty, and the remaining gap where relevant. One or more
explicit sources are required. Source kinds: goal, step, fact, finding, evidence,
attempt, capability, chain. IDs must belong to this task; fact/evidence sources can also use refs
created in the same submitted batch, and capability/chain sources can use stable IDs submitted in that batch. A Finding source uses its committed ID,
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

## Retrieval metadata and directories

Pages and blocks may include `summary` (up to 2,000 characters), `questions` (up to
16 strings of 512 characters), `keywords` and `aliases` (each up to 32 strings of
128 characters). Use relevant ways a future question may refer to this material.
These fields help lexical retrieval; they are locating hints, not new claims,
sources, resolved questions or proof. Keep all conditions in the complete block
text. Use an empty summary or empty arrays to clear hints.

A page may set `parentPageId` to another page in this task, including one created
in the same submission, or `null` to place it at the root. Missing parents and
cycles are rejected. Ancestor titles form a searchable breadcrumb; ancestor
blocks are not evidence and are not fetched merely because they are parents.
Stable page IDs determine file identity, regardless of title or directory moves.

## Required explanations

When a judgment needs another block's qualification to be understood, add this
to the judgment block:

```json
"requiredBlockRefs": [{"pageId": "WK-export-flow", "blockId": "B-scope"}]
```

The target must be an existing block or a block in a full page in the same batch.
Up to 32 unique references are allowed per block. Self-references, cycles and
missing targets in new full judgments are rejected. Sources are still required
on every block; necessary explanations do not replace original observations.

Retrieval carries the complete required explanation closure and its sources,
including corrections and warnings. Oversized packages are deferred as a whole.
Changing or removing a required block marks dependent judgments for review;
their original text remains. Source changes propagate through required blocks.
Resubmitting only the dependent judgment cannot clear an unreviewed dependency.
After reading the originals and reevaluating all affected explanations, submit
their full pages together; forward references are resolved against the final batch.
Removing a block can leave old dependents pending review, never silently current.
Title/directory/retrieval-metadata changes do not acknowledge source changes and
do not change a block's factual dependency signature.

## Metadata-only updates

Metadata-only maintenance needs no new Evidence/Fact. Cite existing IDs in summary;
do not register reading/audit logs, copied originals or Wiki before/after reports as
new observations merely to prove maintenance. With no new observation, return
`result: "no_progress"` and `wikiPages`; controller acceptance records the revision.

To rename/move an existing page or change its hints without reevaluating its
judgments, omit `blocks`. For existing block titles/hints use `blockMetadata`:

```json
{
  "summary": "Improve navigation while retaining source review warnings",
  "result": "no_progress",
  "wikiPages": [{
    "id": "WK-export-flow",
    "title": "Report submission and download boundary",
    "parentPageId": null,
    "aliases": ["report export"],
    "blockMetadata": [{"id": "B-submit", "questions": ["Does a returned identifier prove a completed download?"]}]
  }]
}
```

Only supplied metadata fields change. Blocks, text, sources, requiredBlockRefs
and their sealed review bases are retained. `blockMetadata` cannot change text,
sources or dependencies, cannot add blocks, and cannot accompany a full `blocks`
replacement. New pages require title + blocks. Repeating an identical update
does not create another author revision. Metadata maintenance never clears review
warnings, even after a correction, failed run, checkpoint replay or restart.
