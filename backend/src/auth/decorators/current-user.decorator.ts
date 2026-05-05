// ============================================================
// @CurrentUser() decorator — extracts user from JWT payload
// Example: getProfile(@CurrentUser() user: JwtPayload)
// ============================================================

import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
