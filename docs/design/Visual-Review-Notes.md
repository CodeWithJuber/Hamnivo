# Hamnivo — visual review notes

This kit contains primary screens and representative visual state variants. The accompanying CSV is the fuller behaviour inventory; a listed state does not mean a separate screenshot was generated for it. The images are raster concepts, not editable Figma frames or a working application.

## Cross-board implementation corrections

1. Replace small coral text links with the darker rust token or ink. The source coral on white computes to 3.80:1, below our ordinary text contrast target.
2. The refined session-expired concept masks sensitive transcript content behind the modal. Preserve this in implementation; a dim overlay alone is insufficient. Restore the draft only after successful reauthentication and authorization.
3. The refined sign-in concept replaces its absolute privacy reassurance with a privacy-notice link. Implementation must explain local draft retention and the shared-device option accurately.
4. The interface examples use sample people, numbers and order changes. Resolve cross-screen sample inconsistencies before implementation; no mocked event is evidence of an actual payment, invite, integration or provider capability.
5. Match the approved Hamnivo mark with the actual brand asset when implementing. Generated small icons and wordmarks may not preserve vector geometry exactly.
6. Treat “contrast pass”, evaluation results, connected services and successful actions inside mockups as fictional UI states. This package has not verified the product's accessibility, providers, learning performance or commerce behaviour.
7. Customer email verification must rely on the completed server-side challenge. A typed message such as “I’ve verified my email” is not verification evidence.
8. Mockup thumbnails intentionally show several moments of the same flow. Preserve only the current state in a real product screen; the state callouts are designer annotations, not permanent product UI.

The flow specification and state matrix govern intended behaviour when an image omits a recovery action or compresses explanatory copy. Further pixel-level and native-language review is required after code or editable design production.

## Corrections included in the selected images

- Offline chat no longer shows an AI reply to a locally queued, unsent message. Its action says Queue message and its header reports connection loss.
- The Arabic customer screen has customer navigation; the separate agent translation screen preserves the original and previews what the customer will receive.
- Privileged configuration, developer, team and billing screens display the corresponding actor roles. Tool/API permissions use a named inbox scope and service-account identity.
- Agent publishing is disabled while its required handoff queue is missing; successful publication is shown as a separate state.
- Migration example counts reconcile: 250 records = 238 imported + 8 skipped + 4 failed. The four failures distinguish preflight validation from import execution.
- An uncertain refund outcome directs the user to check status before retrying, and a confirmed refund can still show an order-sync delay.
- Voice support shows consistent customer/human identities and an explicit participant-agreement recording state.

Review performed: visual inspection of generated boards, targeted image regeneration for the issues above, token-pair contrast calculation, state-inventory structure checks, and package integrity checks. No live product or browser-rendered application verification is claimed.
