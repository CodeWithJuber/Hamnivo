# Rifqo · Platform Blueprint — editable Archify sources

Proposed architecture dated 26 September 2026. Rifqo is a working name, not trademark cleared. These diagrams describe the plan, not an implemented production system.

## Contents

- `01-platform`, `02-handoff`, `03-learning`, `04-commerce`, `05-cache`: editable typed JSON, standalone HTML, validation and delivery receipts.
- `assemble.py`: joins the five delivered HTML files into one offline tabbed HTML book and preserves source downloads.
- `REVIEW.json`: exact validation and browser-review limits.
- `LICENSE-Archify.txt`, `THIRD-PARTY-NOTICES-Archify.md`: upstream MIT/font/other notices.
- `static-previews/`: supplemental static SVG/PNG geometry previews. These are not browser screenshots or official interactive exports.

## Rebuild the diagrams

Use Node.js and Archify pinned to commit `9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993`, package version `2.17.0-dev.1` (development snapshot):

```bash
git clone https://github.com/tt-a1i/archify.git archify-tool
git -C archify-tool checkout 9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993
```

For each edited JSON, run the following from this source folder. No global skill install or npm install is needed for the CLI:

```bash
ARCHIFY_UPDATE_CHECK_DISABLED=1 node /absolute/path/to/archify-tool/archify/bin/archify.mjs validate architecture 01-platform.json --quality showcase --json
ARCHIFY_UPDATE_CHECK_DISABLED=1 node /absolute/path/to/archify-tool/archify/bin/archify.mjs deliver architecture 01-platform.json 01-platform.html --quality showcase --json
```

Repeat for each edited diagram. Always inspect return codes. A failed delivery can leave an older HTML in place. Keep receipts from the actual accepted output. Then rebuild the book:

```bash
python3 assemble.py
```

The script writes `Agentic-Chat-Architecture-Diagrams.html` beside these sources. The book includes all five views and editable JSON; it requires no remote runtime service. Open it in a regular browser. Existing JSON source labels use English.

## Browser verification

When Chrome/Chromium is available locally:

```bash
ARCHIFY_UPDATE_CHECK_DISABLED=1 ARCHIFY_CHROME=/path/to/chromium node /absolute/path/to/archify-tool/archify/bin/archify.mjs visual-check 01-platform.html --json
```

Inspect the actual HTML and both themes, all five tabs, keyboard navigation, search/focus, downloads, export and mobile layout. Current work passed deterministic checks. Local browser evidence was skipped because no Chrome/Chromium was available; cloud file navigation was blocked by browser policy. Static geometry previews were inspected separately. No claim of full browser validation is made.

## Semantic boundaries

Public generation receives public or explicitly approved declassified context only, never raw staff notes. Case state, owner and task states remain separate. Human takeover fences new dispatch/publication; accepted external operations require reconciliation. Payment permission remains deterministic and bound to exact consent. Memory is not weight training. Semantic answer reuse is restricted to approved public FAQ. See the master blueprint for complete scope and failure cases.
