import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  base: '/docs',
  integrations: [
    starlight({
      title: 'Hamnivo',
      description: 'User-friendly documentation for Hamnivo',
      logo: {
        src: './src/assets/hamnivo-logo.png',
        alt: 'Hamnivo',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Welcome', slug: 'welcome' },
            { label: '10-minute start', slug: 'start' },
            { label: 'FAQ', slug: 'faq' },
            { label: 'Glossary', slug: 'glossary' },
          ],
        },
        {
          label: 'For your team',
          items: [
            { label: 'Team and roles', slug: 'team' },
            { label: 'Agency clients', slug: 'agency' },
          ],
        },
        {
          label: 'Self-hosting',
          items: [
            { label: 'Self-hosting made simple', slug: 'self-hosting' },
            { label: 'Running as SaaS', slug: 'saas-overview' },
          ],
        },
        {
          label: 'Setup',
          items: [{ autogenerate: { directory: 'setup' } }],
        },
        {
          label: 'Inbox',
          items: [{ autogenerate: { directory: 'inbox' } }],
        },
        {
          label: 'Automation',
          items: [{ autogenerate: { directory: 'automation' } }],
        },
        {
          label: 'AI',
          items: [{ autogenerate: { directory: 'ai' } }],
        },
        {
          label: 'Integrations',
          items: [{ autogenerate: { directory: 'integrations' } }],
        },
        {
          label: 'SaaS',
          items: [{ autogenerate: { directory: 'saas' } }],
        },
      ],
      pagefind: true,
      social: [],
      lastUpdated: true,
    }),
  ],
});
