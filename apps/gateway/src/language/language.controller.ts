import { SetWidgetLanguageRequest } from '@hamnivo/contracts';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { CurrentWidget, WidgetRoute } from '../widget/widget.guard.js';
import { LanguageService } from './language.service.js';

/** A customer's reply language, interface locale and style (U01, HNV-07-04). */
@Controller('v1/widget/language')
export class LanguageController {
  constructor(private readonly language: LanguageService) {}

  @Get()
  @WidgetRoute()
  get(@CurrentWidget() claims: WidgetClaims) {
    return this.language.state(claims);
  }

  @Post()
  @HttpCode(200)
  @WidgetRoute()
  set(@CurrentWidget() claims: WidgetClaims, @Body() body: unknown) {
    return this.language.update(claims, parseInput(SetWidgetLanguageRequest, body));
  }
}
