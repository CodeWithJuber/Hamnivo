export class ToolCallFailure extends Error {
  override readonly name = 'ToolCallFailure';
  constructor(
    readonly kind: string,
    message: string,
    readonly mayHaveApplied: boolean,
  ) {
    super(message);
  }
}
