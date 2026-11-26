// geoip-lite 不自带类型声明,这里提供最小 ambient 声明(仅覆盖用到的 lookup),
// 避免额外引入 @types/geoip-lite 依赖。若日后安装了 @types/geoip-lite,请删除本文件。
declare module 'geoip-lite' {
  export interface GeoIpLookupResult {
    range: [number, number];
    country: string;
    region: string;
    eu: '0' | '1';
    timezone: string;
    city: string;
    ll: [number, number];
    metro: number;
    area: number;
  }
  export function lookup(ip: string): GeoIpLookupResult | null;
  const geoip: { lookup: typeof lookup };
  export default geoip;
}
