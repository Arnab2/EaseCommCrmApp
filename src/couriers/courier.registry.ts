import { Inject, Injectable } from '@nestjs/common';
import { CourierAdapter } from './contracts/courier-adapter.interface';
import { COURIER_ADAPTERS } from './courier.tokens';
import { UnknownCourierException } from './unknown-courier.exception';

@Injectable()
export class CourierRegistry {
  private readonly adaptersByPartner = new Map<string, CourierAdapter>();

  constructor(
    @Inject(COURIER_ADAPTERS) adapters: CourierAdapter[],
  ) {
    for (const adapter of adapters) {
      const partner = this.normalizePartner(adapter.partner);
      if (!partner) {
        throw new Error('A courier adapter must provide a non-empty partner id.');
      }
      if (this.adaptersByPartner.has(partner)) {
        throw new Error(`More than one courier adapter is registered for "${partner}".`);
      }
      this.adaptersByPartner.set(partner, adapter);
    }
  }

  get(partner: string): CourierAdapter {
    const normalizedPartner = this.normalizePartner(partner);
    const adapter = this.adaptersByPartner.get(normalizedPartner);
    if (adapter) return adapter;

    throw new UnknownCourierException(partner, this.listPartners());
  }

  listPartners(): string[] {
    return [...this.adaptersByPartner.keys()].sort();
  }

  private normalizePartner(partner: string): string {
    return partner.trim().toLowerCase();
  }
}
