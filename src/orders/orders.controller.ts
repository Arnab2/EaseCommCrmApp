import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { AuthenticatedClient, AuthenticatedRequest } from '../auth/authenticated-client';
import { CurrentClient } from '../auth/current-client.decorator';
import { RequireScopes } from '../auth/public.decorator';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @RequireScopes('orders:write')
  create(
    @Body() dto: CreateOrderDto,
    @CurrentClient() client: AuthenticatedClient,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.orders.create(dto, {
      client,
      requestId: request.requestId ?? 'unknown',
    });
  }

  @Get(':order_id')
  @RequireScopes('orders:read')
  getOrder(
    @Param('order_id') orderId: string,
    @CurrentClient() client: AuthenticatedClient,
  ) {
    return this.orders.getOrder(orderId, client);
  }

  @Get(':order_id/track')
  @RequireScopes('orders:track')
  track(
    @Param('order_id') orderId: string,
    @CurrentClient() client: AuthenticatedClient,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.orders.track(
      orderId,
      client,
      request.requestId ?? 'unknown',
    );
  }

  @Post(':order_id/cancel')
  @RequireScopes('orders:cancel')
  cancel(
    @Param('order_id') orderId: string,
    @Body() dto: CancelOrderDto,
    @CurrentClient() client: AuthenticatedClient,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.orders.cancel(
      orderId,
      dto,
      client,
      request.requestId ?? 'unknown',
    );
  }
}
