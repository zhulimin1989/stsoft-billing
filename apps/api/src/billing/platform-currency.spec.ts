import { resolvePlatformCurrency } from './platform-currency';

describe('resolvePlatformCurrency', () => {
  it('uses explicit platform currency before deployment region', () => {
    expect(resolvePlatformCurrency(undefined, { region: 'domestic', currency: 'sgd' })).toMatchObject({
      currency: 'sgd',
      currencyCode: 'SGD',
      currencySymbol: 'S$',
    });
  });

  it('defaults domestic deployment to CNY when currency is not configured', () => {
    expect(resolvePlatformCurrency(undefined, { region: 'domestic' })).toMatchObject({
      currency: 'cny',
      currencyCode: 'CNY',
      currencySymbol: '¥',
    });
  });

  it('defaults overseas deployment to USD when currency is not configured', () => {
    expect(resolvePlatformCurrency(undefined, { region: 'overseas' })).toMatchObject({
      currency: 'usd',
      currencyCode: 'USD',
      currencySymbol: '$',
    });
  });
});
