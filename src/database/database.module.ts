import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('database.url'),
        ssl: config.get<boolean>('database.ssl')
          ? { rejectUnauthorized: true }
          : false,
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: false,
        retryAttempts: config.get<number>('database.retryAttempts', 5),
        retryDelay: config.get<number>('database.retryDelayMs', 3000),
        extra: {
          max: config.get<number>('database.poolMax', 10),
          connectionTimeoutMillis: config.get<number>(
            'database.connectTimeoutMs',
            5000,
          ),
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
