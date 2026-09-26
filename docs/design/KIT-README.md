# Hamnivo UI & UX Mockup Kit

This delivery contains **28 static visual boards**, **168 rows of UX state specifications**, and **8 brand assets**.

## Open the kit

For the ZIP delivery, extract the entire archive into one folder, then open `Hamnivo-UI-UX-Gallery.html` in a modern browser. Keep the `screenshots/` and `brand-assets/` folders beside it: this gallery uses relative image paths and works offline. The separately supplied standalone HTML is self-contained and embeds every original image. Both versions embed the state matrix and flow specification, including their download links.

Use search and the product-area filter to find a board. Select an image for full view; use the previous/next controls or arrow keys and Escape to close. Original images are shown with `object-fit: contain`, so compositions are not cropped. Browser display scaling does not change the source files.

## Files

- `screenshots/`: 28 individually named original board PNGs.
- `brand-assets/`: the six product illustrations, revised Hamnivo logo and icon. The multilingual and checkout illustrations are included explicitly.
- `UX-State-Matrix.csv`: expected states, transitions and recovery behavior. A row is a specification, not necessarily its own rendered screenshot.
- `UX-Flow-Specification.md`: UX flow and interaction guidance.
- `boards.json`: board descriptions and generation prompts for further design iterations.
- `manifest.json`: image dimensions, byte counts, hashes and computed delivery counts.
- `Hamnivo-UI-UX-Gallery.html`: searchable, offline gallery using the adjacent original images and embedded specifications.
- `Design-System.md`: additional design handoff guidance.
- `Visual-Review-Notes.md`: additional design handoff guidance.
- `build_kit.py`: build source.
- `build_state_specs.py`: build source.

## Design intent and limits

These are generated visual concepts and a design handoff, not implemented software. Board labels and visual microcopy are illustrative; the written state/flow specification is the behavioral reference. A board may combine several selected states. The kit does not claim every state row is separately rendered. It is not a guarantee of every possible runtime state.

No production accessibility, responsive implementation, backend, security, identity, payment, provider, translation or agent-behavior validation has been performed by creating these images. Any numbers, conversation examples or indicators in mockups are sample content, not measured product capabilities. Implement and test the specified flows before release. The gallery itself uses native controls, visible keyboard focus and a native modal dialog; this is not an accessibility certification.

Original raster files are unchanged byte copies. No resize, recolor, crop, retouch or format conversion was applied. The ZIP gallery references the included originals rather than duplicating embedded raster data. The separately delivered standalone HTML embeds originals for convenient one-file viewing.

Brand palette: ink `#192A30`, ivory `#F6F3EC`, coral `#E45136`.

Generated: 2026-09-26T21:01:37+00:00
