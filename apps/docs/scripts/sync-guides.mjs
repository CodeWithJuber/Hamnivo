// Copies the feature guides in docs/guide/<area>/*.md into the site, so each area's sidebar
// section fills itself. A guide without front matter gets its title from its first heading.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../../../docs/guide');
const target = join(here, '../src/content/docs');
const areas = ['setup', 'inbox', 'ai', 'integrations', 'saas'];

let copied = 0;
for (const area of areas) {
  const out = join(target, area);
  mkdirSync(out, { recursive: true });
  // Only what an earlier run copied: everything here but .gitkeep comes from docs/guide.
  for (const old of readdirSync(out)) if (old.endsWith('.md')) rmSync(join(out, old));
  const dir = join(source, area);
  let files = [];
  try {
    if (statSync(dir).isDirectory()) files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    continue;
  }
  for (const file of files) {
    let text = readFileSync(join(dir, file), 'utf8');
    if (!text.startsWith('---')) {
      const heading = text.match(/^#\s+(.+)$/m);
      const title = heading ? heading[1].trim() : file.replace(/\.md$/, '').replace(/-/g, ' ');
      if (heading) text = text.replace(heading[0], '').replace(/^\s+/, '');
      text = `---\ntitle: ${JSON.stringify(title)}\n---\n\n${text}`;
    }
    // Guides link to each other as files (`ai-keys.md`, `../ai/test-your-ai.md`); every page is
    // served as a folder (`/docs/setup/getting-started/`), so those links move one level up.
    text = text.replace(
      /\]\((?!https?:|\/|#|mailto:)([^)\s]+?)\.md(#[^)\s]*)?\)/g,
      (_, path, hash = '') => `](../${path}/${hash})`,
    );
    writeFileSync(join(out, file), text);
    copied += 1;
  }
}
console.log(`docs: ${copied} guide page(s) copied from docs/guide`);
