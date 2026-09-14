# Third-party notices

`cvss/cvss31-calculator.cjs` is the corrected Webounty CVSS 3.1 Base calculator
from `webounty/scripts/cvss31-calculator.js`, originally adapted from Web-Vulnhunt
in Jase-SecKit. The `.cjs` extension permits the existing CommonJS module to be
imported from Xloom's ESM runtime; its calculator implementation is unchanged.
The original's normalized SHA-256 is recorded in [cvss/provenance.json](cvss/provenance.json),
so distribution integrity checks do not require a separate Webounty checkout.

Copyright (c) 2026 w1th0ut (U-Sec / 无界安全).
The complete MIT notice is preserved in [cvss/LICENSE](cvss/LICENSE).

CVSS is owned by FIRST.Org, Inc. and used by permission.
Normative formula: <https://www.first.org/cvss/v3.1/specification-document>.
Metric guidance: <https://www.first.org/cvss/v3.1/user-guide>.
