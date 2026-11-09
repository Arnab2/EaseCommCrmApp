import { BadRequestException } from '@nestjs/common';

export class UnknownCourierException extends BadRequestException {
  constructor(partner: string, supportedPartners: string[]) {
    super({
      code: 'UNKNOWN_COURIER',
      message: `Courier partner "${partner}" is not supported.`,
      details: [
        {
          field: 'courier_partner',
          message: 'Choose one of the supported courier partners.',
          supported_partners: supportedPartners,
        },
      ],
    });
  }
}
