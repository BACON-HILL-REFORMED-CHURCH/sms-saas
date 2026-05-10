import { Module } from '@nestjs/common';
import { EsimService } from './esim.service';
import { EsimController, EsimAdminController } from './esim.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EsimController, EsimAdminController],
  providers: [EsimService],
  exports: [EsimService],
})
export class EsimModule {}
