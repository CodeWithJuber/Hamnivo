// Copies the feature guides in docs/guide/<area>/*.md into the site, so each area's sidebar
// section fills itself, and the brand's tab icon into public/. A guide without front matter gets
// its title from its first heading.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../../../docs/guide');
const target = join(here, '../src/content/docs');
const areas = ['setup', 'inbox', 'ai', 'integrations', 'saas'];
const repository = 'https://github.com/CodeWithJuber/Hamnivo/blob/main';

// Guides link to other guides and to files of the repository by relative path, as GitHub shows
// them (`ai-keys.md`, `../ai/test-your-ai.md`, `../../../examples/html`). On the site every guide
// is a folder (`/docs/setup/getting-started/`): a link to a guide becomes that guide's page, and a
// link to any other file of the repository opens it on GitHub.
function siteLinks(text, area) {
  return text.replace(
    /\]\((?!https?:|\/|#|mailto:)([^)\s#]+)(#[^)\s]*)?\)/g,
    (_, path, hash = '') => {
      const file = posix.normalize(posix.join('docs/guide', area, path));
      if (file.startsWith('docs/guide/') && file.endsWith('.md')) {
        const page = file.slice('docs/guide/'.length, -'.md'.length).toLowerCase();
        return `](../../${page}/${hash})`;
      }
      return `](${repository}/${file}${hash})`;
    },
  );
}

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
    writeFileSync(join(out, file), siteLinks(text, area));
    copied += 1;
  }
}

// Starlight looks for the tab icon at /docs/favicon.svg.
mkdirSync(join(here, '../public'), { recursive: true });
copyFileSync(
  join(here, '../../../packages/brand/assets/favicon.svg'),
  join(here, '../public/favicon.svg'),
);
console.log(`docs: ${copied} guide page(s) copied from docs/guide`);
