import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Direction } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { ReauthDialog } from './components/ReauthDialog';
import { directionOf, isLocale } from './i18n';
import { queryClient } from './lib/query-client';
import { router } from './router';

export function App() {
  const { i18n } = useTranslation();
  // Menus, radio groups and tabs follow the reading direction for arrow keys too.
  const dir = directionOf(isLocale(i18n.language) ? i18n.language : 'en');
  return (
    <QueryClientProvider client={queryClient}>
      <Direction.Provider dir={dir}>
        <AnnouncerProvider>
          <RouterProvider router={router} />
          <ReauthDialog />
        </AnnouncerProvider>
      </Direction.Provider>
    </QueryClientProvider>
  );
}
