import { OnboardingController } from './onboarding.controller.js';
import { OnboardingService } from './onboarding.service.js';

/** What a business owner sets up from Studio alone, in the API: the setup wizard (A01). */
export const SETUP_API_CONTROLLERS = [OnboardingController];

export const SETUP_API_PROVIDERS = [OnboardingService];
