import { Controller, Get } from '@nestjs/common';
import { SignupPolicy } from '../platform/signup.js';

/** What the sign-up page needs before anyone is signed in. */
@Controller('v1/signup')
export class SignupController {
  constructor(private readonly signup: SignupPolicy) {}

  /** Whether public sign-up is open and, when the check is on, the Turnstile site key. */
  @Get()
  settings() {
    return this.signup.settings();
  }
}
