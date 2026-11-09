import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CouriersModule } from '../couriers/couriers.module';
import { CourierOperationAttemptEntity } from './entities/courier-operation-attempt.entity';
import { OrderEntity } from './entities/order.entity';
import { TrackingEventEntity } from './entities/tracking-event.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      CourierOperationAttemptEntity,
      TrackingEventEntity,
    ]),
    CouriersModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
