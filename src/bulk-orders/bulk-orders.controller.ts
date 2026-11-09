import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  AuthenticatedClient,
  AuthenticatedRequest,
} from '../auth/authenticated-client';
import { CurrentClient } from '../auth/current-client.decorator';
import { RequireScopes } from '../auth/public.decorator';
import { CreateBulkOrdersDto } from './dto/create-bulk-orders.dto';
import { BulkOrdersService } from './bulk-orders.service';

@Controller('orders/bulk')
export class BulkOrdersController {
  constructor(private readonly bulkOrders: BulkOrdersService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('orders:write')
  submit(
    @Body() dto: CreateBulkOrdersDto,
    @CurrentClient() client: AuthenticatedClient,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bulkOrders.submit(dto, client, request.requestId ?? 'unknown');
  }

  @Get(':batch_id')
  @RequireScopes('orders:read')
  getBatch(
    @Param('batch_id') batchId: string,
    @CurrentClient() client: AuthenticatedClient,
  ) {
    return this.bulkOrders.getBatch(batchId, client);
  }
}
