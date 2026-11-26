import { ApiKeyService } from './apikey.service';

describe('ApiKeyService.listAvailableModels', () => {
  it('uses displayName for the label while keeping modelName as the runtime value', async () => {
    const modelPricingService = {
      listPublic: jest.fn().mockResolvedValue([
        {
          modelName: 'gpt-4o',
          displayName: 'GPT-4o 用户版',
          inputPricePerMToken: 2.5,
          outputPricePerMToken: 10,
        },
      ]),
    };
    const service = new ApiKeyService(
      {} as never,
      {} as never,
      modelPricingService as never,
    );

    await expect(service.listAvailableModels()).resolves.toEqual([
      {
        label: 'GPT-4o 用户版',
        value: 'gpt-4o',
        inputPrice: 2.5,
        outputPrice: 10,
      },
    ]);
  });
});
