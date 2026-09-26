import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect } from 'react';
import { AnnouncerProvider } from '../src/components/live-region';
import { Toaster } from '../src/components/sonner';
import { TooltipProvider } from '../src/components/tooltip';
import '../src/styles/globals.css';

const withShell: Decorator = (Story, context) => {
  const { theme, direction } = context.globals as {
    theme: 'light' | 'dark';
    direction: 'ltr' | 'rtl';
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dir = direction;
    document.documentElement.lang = direction === 'rtl' ? 'ar' : 'en';
  }, [theme, direction]);
  return (
    <AnnouncerProvider>
      <TooltipProvider>
        <div className="min-h-dvh bg-bg p-6 text-text">
          <Story />
        </div>
        <Toaster />
      </TooltipProvider>
    </AnnouncerProvider>
  );
};

const preview: Preview = {
  decorators: [withShell],
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: { title: 'Theme', icon: 'mirror', items: ['light', 'dark'], dynamicTitle: true },
    },
    direction: {
      description: 'Text direction',
      toolbar: { title: 'Direction', icon: 'transfer', items: ['ltr', 'rtl'], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: 'light', direction: 'ltr' },
  parameters: {
    layout: 'fullscreen',
    // Accessibility violations fail the story test run instead of only warning.
    a11y: { test: 'error' },
    controls: { expanded: true },
  },
};

export default preview;
