// ============================================================
// Custom Throttler Guard — stricter limits on auth endpoints
// ============================================================

import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  // Override error message to be consistent with our ApiResponse shape
  protected async throwThrottlingException(): Promise<void> {
    throw new Error('Too many requests. Please slow down.');
  }
}
