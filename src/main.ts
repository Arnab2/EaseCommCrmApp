import 'reflect-metadata';
// Load local environment values before feature modules evaluate decorators
// that need static options, including BullMQ worker concurrency.
import 'dotenv/config';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { toValidationDetails } from './common/validation/validation-details';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const requestIdMiddleware = new RequestIdMiddleware();

  app.setGlobalPrefix('api/v1');
  app.use((request: Request, response: Response, next: NextFunction) =>
    requestIdMiddleware.use(request, response, next),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) =>
        new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: toValidationDetails(errors),
        }),
    }),
  );
  app.enableShutdownHooks();

  const port = config.get<number>('app.port', 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
