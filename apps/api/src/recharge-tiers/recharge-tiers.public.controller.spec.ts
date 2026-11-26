import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PublicRechargeTiersController } from './recharge-tiers.public.controller';
import { RechargeTiersService } from './recharge-tiers.service';

describe('PublicRechargeTiersController', () => {
  let controller: PublicRechargeTiersController;
  let service: { listPublicActive: jest.Mock };

  beforeEach(async () => {
    service = { listPublicActive: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicRechargeTiersController],
      providers: [{ provide: RechargeTiersService, useValue: service }],
    }).compile();

    controller = module.get(PublicRechargeTiersController);
  });

  it('returns active recharge tiers for a product', async () => {
    service.listPublicActive.mockResolvedValueOnce({
      items: [{ id: 'tier-1', amountCents: 1000, bonusCents: 100 }],
    });

    const result = await controller.list(' product-1 ');

    expect(service.listPublicActive).toHaveBeenCalledWith('product-1');
    expect(result).toEqual({
      code: 0,
      message: 'ok',
      data: { items: [{ id: 'tier-1', amountCents: 1000, bonusCents: 100 }] },
    });
  });

  it('requires productId', async () => {
    await expect(controller.list('   ')).rejects.toBeInstanceOf(BadRequestException);
  });
});
