import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';

describe('ChannelController', () => {
  it('preserves the publisher compile-preview response envelope', async () => {
    const preview = {
      providerId: 'openai',
      publisherRequest: { id: 'openai', provider_profile: 'openai_compatible' },
      publisherCompiled: { binding_names: ['openai_chat'] },
      mode: 'publisher_compiler',
    };
    const channelService = {
      previewPublisherCompile: jest.fn().mockResolvedValue(preview),
    } as unknown as ChannelService;
    const controller = new ChannelController(channelService);
    const body = {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      providerProfile: 'openai_compatible',
    };

    await expect(controller.publisherCompilePreview(body)).resolves.toEqual({
      code: 0,
      message: 'ok',
      data: preview,
    });
    expect(channelService.previewPublisherCompile).toHaveBeenCalledWith(body);
  });
});
