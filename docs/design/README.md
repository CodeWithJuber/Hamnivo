# Hamnivo UI/UX design kit

This folder holds the design handoff that the Hamnivo UI implements. The kit was supplied by the
product owner (design date 27 September 2026) as static concepts plus behavioural specifications.

| File | Purpose |
|---|---|
| `UX-State-Matrix.csv` | 168 state rows (`HNV-xx-yy`): trigger, visible UI, primary action, recovery, role, privacy rule. **Behavioural reference.** |
| `UX-Flow-Specification.md` | Shared design contract, 8 end-to-end journeys (A–H), 15-state interaction contract, microcopy |
| `Design-System.md` | Colour tokens, type, geometry, responsive and component rules |
| `Visual-Review-Notes.md` | Corrections the implementation must apply (contrast, masking, honest copy, …) |
| `boards.json`, `manifest.json` | Board index (28 boards, states, surface) and original image hashes |
| `boards/*.webp` | Optimized copies of the 28 board mockups for review |

The original full-resolution board PNGs (~38 MB) are not committed. They are available in the
`Hamnivo-UI-UX-Mockups.zip` delivery (Google Drive file `1hoUirpAAMjCZ7c_6F4QyD0WDnfbCuspZ`) and are
verified against the SHA-256 hashes in `manifest.json`. Locally they are expected in
`docs/design/.originals/` (git-ignored).

## Rules of use

- The state matrix and flow specification govern behaviour; boards are visual direction only.
- Every implemented state cites its `HNV-xx-yy` ID in its Storybook story and Playwright spec.
- Implementation status is tracked in [`../feature-status.md`](../feature-status.md); a mockup existing
  does not mark a state as built or tested.
- Sample people, numbers and orders in the boards are illustrative. Tests use one consistent seeded
  fixture instead.
