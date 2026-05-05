// ============================================================
// UsersModule — user CRUD (used by AuthModule + AdminModule)
// ============================================================

import { Module } from '@nestjs/common';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
