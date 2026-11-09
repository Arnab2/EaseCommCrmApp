import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMode } from '../../couriers/contracts/shipment-status';
import { CourierAddress } from '../../couriers/contracts/courier-contracts';

export class AddressDto implements CourierAddress {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(40) phone!: string;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string;
  @IsString() @IsNotEmpty() @MaxLength(240) addressLine1!: string;
  @IsOptional() @IsString() @MaxLength(240) addressLine2?: string;
  @IsString() @IsNotEmpty() @MaxLength(120) city!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) state!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) country!: string;
  @IsString() @IsNotEmpty() @MaxLength(20) postalCode!: string;
  @IsOptional() @IsString() @MaxLength(60) addressType?: string;
}

export class ItemDto {
  @IsString() @IsNotEmpty() @MaxLength(500) description!: string;
  @Type(() => Number) @IsInt() @Min(1) quantity!: number;
}

export class ParcelDto {
  @Type(() => Number) @IsInt() @Min(1) pieces!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) weightKg!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) lengthCm!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) breadthCm!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) heightCm!: number;
}

export class InvoiceDto {
  @IsString() @IsNotEmpty() @MaxLength(120) number!: string;
  @IsString() @IsNotEmpty() @MaxLength(40) date!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) value!: number;
}

export class CreateOrderDto {
  @IsString() @IsNotEmpty() @MaxLength(120) order_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) courier_partner!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) service_type!: string;
  @IsIn(['PREPAID', 'COD']) payment_mode!: PaymentMode;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) declared_value!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) collectable_value!: number;
  @ValidateNested() @Type(() => ItemDto) item!: ItemDto;
  @ValidateNested() @Type(() => ParcelDto) parcel!: ParcelDto;
  @ValidateNested() @Type(() => InvoiceDto) invoice!: InvoiceDto;
  @ValidateNested() @Type(() => AddressDto) shipper!: AddressDto;
  @ValidateNested() @Type(() => AddressDto) consignee!: AddressDto;
  @ValidateNested() @Type(() => AddressDto) return_address!: AddressDto;
}
