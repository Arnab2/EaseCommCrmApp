import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersModule } from '../orders/orders.module';
import { CouriersModule } from '../couriers/couriers.module';
import { BulkOrderBatchEntity } from './entities/bulk-order-batch.entity';
import { BulkOrderItemEntity } from './entities/bulk-order-item.entity';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { BULK_ORDERS_QUEUE } from './bulk-orders.constants';
import { redisConnectionOptions } from './redis-connection';
import { BulkOrdersController } from './bulk-orders.controller';
import { BulkOrdersService } from './bulk-orders.service';
import { BulkOrderWorker } from './bulk-order.worker';
import { BulkOutboxPublisher } from './bulk-outbox.publisher';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      BulkOrderBatchEntity,
      BulkOrderItemEntity,
      OutboxEventEntity,
    ]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionOptions(
          config.getOrThrow<string>('redis.url'),
        ),
      }),
    }),
    BullModule.registerQueue({ name: BULK_ORDERS_QUEUE }),
    OrdersModule,
    CouriersModule,
  ],
  controllers: [BulkOrdersController],
  providers: [BulkOrdersService, BulkOrderWorker, BulkOutboxPublisher],
  exports: [BulkOrdersService],
})
export class BulkOrdersModule {}
