import type { Provider } from '@nestjs/common';
import { InboxLibraryController } from './library.controller.js';
import { InboxLibraryService } from './library.service.js';

/** Studio's editor for a brand's saved replies and tags, in the API. */
export const LIBRARY_API_CONTROLLERS = [InboxLibraryController];

export const LIBRARY_API_PROVIDERS: Provider[] = [InboxLibraryService];
