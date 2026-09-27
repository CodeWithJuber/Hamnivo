/** Everything links to the default branch, so the site never points at a stale fork or tag. */
export const repoUrl = 'https://github.com/CodeWithJuber/Hamnivo';

const blob = `${repoUrl}/blob/main`;

export const links = {
  repo: repoUrl,
  selfHosting: `${blob}/docs/self-hosting.md`,
  putChatOnPage: `${blob}/docs/self-hosting.md#put-the-chat-on-a-web-page`,
  featureStatus: `${blob}/docs/feature-status.md`,
  docs: `${repoUrl}/tree/main/docs`,
  license: `${blob}/LICENSE`,
} as const;
