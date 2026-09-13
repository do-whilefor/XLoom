# Native CVSS 3.1 Base assessment

Use the supplied calculator path through the existing PowerShell tool, or submit
the vector for the Controller to calculate in process. It supports CVSS 3.1 Base
only. Temporal, Environmental and other versions are rejected. Do not submit
baseScore or severity: those fields are deterministic outputs.

Execute adds `cvss` to an existing/new Finding proposal:

```json
{
  "vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
  "rationale": {
    "AV": {"reason":"Explain reachability", "factRefs":["f1"], "assumption":false},
    "AC": {"reason":"Explain conditions outside the attacker's control", "factRefs":[], "assumption":true},
    "PR": {"reason":"Explain privileges required before the attack", "factRefs":[], "assumption":true},
    "UI": {"reason":"Explain other-user interaction", "factRefs":[], "assumption":true},
    "S": {"reason":"Explain security authority boundary", "factRefs":[], "assumption":true},
    "C": {"reason":"Explain supported confidentiality impact", "factRefs":[], "assumption":true},
    "I": {"reason":"Explain integrity impact or lack thereof", "factRefs":[], "assumption":true},
    "A": {"reason":"Explain availability impact or lack thereof", "factRefs":[], "assumption":true}
  }
}
```

All eight metric reasons are required. Use exact committed or same-batch Fact refs
attached to the Finding. `assumption:false` requires supporting Facts. A schema
check cannot judge their meaning: read original evidence. Unknown metrics remain
explicit assumptions; the resulting score is conditional.

Decide can review or revise scoring independently with
`cvssReviews:[{findingId:"V-exact-id",assessment:{vector,rationale},reason:"..."}]`.
Controller recalculates the full vector, verifies referenced artifacts and stores
the review. A reviewed conditional assessment still displays its assumptions.
Source or Finding changes require another review. Superseded direct Facts cannot
be used as current metric support. To change a Finding's verification or P rating,
use the existing evidence-backed Finding review protocol separately.

PR is privilege before the attack. UI refers to another user's participation.
S concerns security authority, not merely a different URL or service. C/I/A follow
demonstrated impact, not token presence or a success status alone. Never add or
average chain member scores. Do not translate Base score into P1/P2/P3 or task
priority automatically. This release scores individual Findings only.

See FIRST [Specification](https://www.first.org/cvss/v3.1/specification-document)
and [User Guide](https://www.first.org/cvss/v3.1/user-guide).
