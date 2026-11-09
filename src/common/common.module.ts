import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NormalizedExceptionFilter } from './normalized-exception.filter';

@Module({
  providers: [
    { provide: APP_FILTER, useClass: NormalizedExceptionFilter },
  ],
})
export class CommonModule {}
