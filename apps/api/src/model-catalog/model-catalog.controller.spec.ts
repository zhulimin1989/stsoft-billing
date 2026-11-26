/**
 * ModelCatalogController unit tests — verifies the wire shape (ApiResponse
 * envelope) and that query params are passed through to the service.
 */

import { Test } from '@nestjs/testing';
import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { ModelCatalogController } from './model-catalog.controller';
import { ModelCatalogService } from './model-catalog.service';

describe('ModelCatalogController route metadata (C1 regression)', () => {
  // Combined with the global `app.setGlobalPrefix('api')` + URI versioning
  // (prefix 'v') in main.ts, this mounts at /api/v1/models/catalog. The
  // earlier @Controller('api/v1/models/catalog') was wrong: it produced
  // /api/api/v1/models/catalog because the global prefix was applied on top
  // of the literal path, and 'v1' was treated as a path segment instead of
  // a real Nest version.
  it('uses path "models/catalog" with version "1" (not literal "api/v1/...")', () => {
    const path = Reflect.getMetadata(PATH_METADATA, ModelCatalogController);
    const version = Reflect.getMetadata(VERSION_METADATA, ModelCatalogController);
    expect(path).toBe('models/catalog');
    expect(version).toBe('1');
  });
});

describe('ModelCatalogController', () => {
  let controller: ModelCatalogController;
  let service: { list: jest.Mock; getOne: jest.Mock };

  beforeEach(async () => {
    service = {
      list: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue({ id: 'mp_1', modelName: 'gpt-4o' }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ModelCatalogController],
      providers: [{ provide: ModelCatalogService, useValue: service }],
    }).compile();

    controller = moduleRef.get(ModelCatalogController);
  });

  it('list returns ApiResponse envelope wrapping items array', async () => {
    service.list.mockResolvedValue([{ id: 'mp_1', modelName: 'gpt-4o' }]);
    const res = await controller.list({});
    expect(res).toEqual({
      code: 0,
      message: 'ok',
      data: { items: [{ id: 'mp_1', modelName: 'gpt-4o' }] },
    });
  });

  it('list forwards trimmed provider/tag/productId query params', async () => {
    await controller.list({ provider: '  openai ', tag: ' 推理 ', productId: ' prod_1 ' });
    expect(service.list).toHaveBeenCalledWith({
      provider: 'openai',
      tag: '推理',
      productId: 'prod_1',
    });
  });

  it('list passes undefined when query params are empty strings', async () => {
    await controller.list({ provider: '', tag: '   ', productId: ' ' });
    expect(service.list).toHaveBeenCalledWith({
      provider: undefined,
      tag: undefined,
      productId: undefined,
    });
  });

  it('getOne decodes URI component from path param', async () => {
    await controller.getOne('openai%2Fgpt-4o', {});
    expect(service.getOne).toHaveBeenCalledWith('openai/gpt-4o', { productId: undefined });
  });

  it('getOne forwards trimmed productId query param', async () => {
    await controller.getOne('gpt-4o', { productId: ' prod_1 ' });
    expect(service.getOne).toHaveBeenCalledWith('gpt-4o', { productId: 'prod_1' });
  });

  it('getOne wraps result in ApiResponse envelope', async () => {
    const res = await controller.getOne('gpt-4o', {});
    expect(res).toEqual({
      code: 0,
      message: 'ok',
      data: { id: 'mp_1', modelName: 'gpt-4o' },
    });
  });
});
