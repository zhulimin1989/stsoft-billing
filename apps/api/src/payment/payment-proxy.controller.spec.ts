import { PaymentProxyController } from './payment-proxy.controller';

function makeReplyStub() {
  const reply: Record<string, jest.Mock> = {};
  reply.header = jest.fn().mockReturnValue(reply);
  reply.status = jest.fn().mockReturnValue(reply);
  reply.send = jest.fn().mockResolvedValue(undefined);
  return reply;
}

describe('PaymentProxyController notifications', () => {
  function buildController() {
    const billingPortal = {
      requestRaw: jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('ok'),
      }),
    };
    const controller = new PaymentProxyController(billingPortal as any);
    return { controller, billingPortal };
  }

  it('fails notification forwarding when rawBody is unavailable', async () => {
    const { controller, billingPortal } = buildController();
    const reply = makeReplyStub();

    await controller.stripeWebhook({
      headers: { 'content-type': 'application/json' },
      body: { b: 2, a: 1 },
    } as any, reply as any);

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({
      code: 500,
      message: 'Payment notification raw body unavailable',
      data: null,
    });
    expect(billingPortal.requestRaw).not.toHaveBeenCalled();
  });

  it('forwards the captured raw bytes without serializing parsed body', async () => {
    const { controller, billingPortal } = buildController();
    const reply = makeReplyStub();
    const raw = Buffer.from('{"b":2,"a":1}');

    await controller.stripeWebhook({
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'sig',
      },
      rawBody: raw,
      body: { a: 1, b: 2 },
    } as any, reply as any);

    expect(billingPortal.requestRaw).toHaveBeenCalledWith(
      'POST',
      '/payment/notify/stripe',
      undefined,
      raw,
      expect.objectContaining({
        'content-type': 'application/json',
        'stripe-signature': 'sig',
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(Buffer.from('ok'));
  });
});
