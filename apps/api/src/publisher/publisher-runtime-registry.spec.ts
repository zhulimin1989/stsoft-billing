import { contractVersion } from '@raytone-lab/publisher-contracts';
import {
  apiTypesForProviderSdk,
  buildProtocolPathsFromServedInboundProtocols,
  defaultPathPrefixForApiType,
  inferProviderProfile,
  isCatalogOnlySdkType,
  resolveProviderRuntimeIntent,
} from './publisher-runtime-registry';

describe('publisher runtime registry', () => {
  it('pins the Publisher 3.4.0 contract required by Ark video intent', () => {
    expect(contractVersion).toBe('3.4.0');
  });

  it('compiles Seedance as native Ark video instead of catalog-only media', () => {
    expect(isCatalogOnlySdkType('seedance_video')).toBe(false);
    expect(apiTypesForProviderSdk('seedance', 'seedance_video')).toEqual(['ark']);
    expect(inferProviderProfile('seedance', ['ark'])).toBe('ark_video_native');
    expect(defaultPathPrefixForApiType('ark')).toBe('/api/v3');
    expect(resolveProviderRuntimeIntent('seedance', [{
      isActive: true,
      status: 'active',
      providerProfile: null,
      clientCompatibility: null,
      servedInboundProtocols: null,
      tokenCountStrategy: null,
    }], ['ark'])).toEqual({
      providerProfile: 'ark_video_native',
      clientCompatibility: [],
      servedInboundProtocols: ['ark'],
    });
    expect(buildProtocolPathsFromServedInboundProtocols(
      ['ark'],
      'ark_video_native',
    )).toEqual([{ inbound_protocol: 'ark', channel: 'passthrough' }]);
  });

  it('keeps existing non-video SDK routing classifications byte-for-byte unchanged', () => {
    const compiled = [
      ['openai', 'openai_completions'],
      ['openai', 'openai_responses'],
      ['anthropic', 'anthropic'],
      ['google', 'gemini'],
      ['doubao', 'doubao'],
      ['zhipu', 'glm'],
      ['zhipu', 'glm_coding'],
      ['cohere', 'cohere_v2'],
      ['openai', 'openai_image'],
      ['minimax', 'minimax_image'],
      ['minimax', 'minimax_video'],
      ['runway', 'runway_video'],
      ['kling', 'kling_video'],
    ].map(([provider, sdkType]) => ({
      provider,
      sdkType,
      apiTypes: apiTypesForProviderSdk(provider, sdkType),
    }));

    expect(JSON.stringify(compiled)).toBe(
      '[{"provider":"openai","sdkType":"openai_completions","apiTypes":["openai"]},'
      + '{"provider":"openai","sdkType":"openai_responses","apiTypes":["openai_responses"]},'
      + '{"provider":"anthropic","sdkType":"anthropic","apiTypes":["anthropic"]},'
      + '{"provider":"google","sdkType":"gemini","apiTypes":["gemini"]},'
      + '{"provider":"doubao","sdkType":"doubao","apiTypes":["doubao"]},'
      + '{"provider":"zhipu","sdkType":"glm","apiTypes":["glm"]},'
      + '{"provider":"zhipu","sdkType":"glm_coding","apiTypes":["glm_coding"]},'
      + '{"provider":"cohere","sdkType":"cohere_v2","apiTypes":["cohere_v2"]},'
      + '{"provider":"openai","sdkType":"openai_image","apiTypes":[]},'
      + '{"provider":"minimax","sdkType":"minimax_image","apiTypes":[]},'
      + '{"provider":"minimax","sdkType":"minimax_video","apiTypes":[]},'
      + '{"provider":"runway","sdkType":"runway_video","apiTypes":[]},'
      + '{"provider":"kling","sdkType":"kling_video","apiTypes":[]}]',
    );
  });
});
