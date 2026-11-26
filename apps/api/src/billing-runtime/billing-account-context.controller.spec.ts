import { BillingAccountContextController } from './billing-account-context.controller';

describe('BillingAccountContextController', () => {
  it('reads recent orders through the account context route', async () => {
    const billingAdmin = {
      listRecentOrdersForUser: jest.fn().mockResolvedValue([
        {
          id: 'order-1',
          amountCents: 1234,
          status: 'PAID',
          createdAt: new Date('2026-05-26T00:00:00.000Z'),
        },
      ]),
    };
    const controller = new BillingAccountContextController(billingAdmin as any);

    const result = await controller.listRecentOrdersForUser('user-1', '50');

    expect(billingAdmin.listRecentOrdersForUser).toHaveBeenCalledWith('user-1', 20);
    expect(result).toEqual({
      code: 0,
      message: 'ok',
      data: {
        items: [
          {
            id: 'order-1',
            amountCents: 1234,
            status: 'PAID',
            createdAt: new Date('2026-05-26T00:00:00.000Z'),
          },
        ],
      },
    });
  });
});
