import geoip from 'geoip-lite';

export interface GeoResult {
  /** ISO 3166-1 alpha-2 国家码,如 CN / US;查不到为 undefined */
  country?: string;
  /** 城市名(英文,精度中等);查不到为 undefined */
  city?: string;
}

/**
 * IP → 地理(国家/城市),geoip-lite 本地库离线查表。
 *
 * geo 是"尽力而为"字段:无效/私网 IP、查不到、库异常一律返回空对象,
 * 绝不抛异常 —— 调用方在 attribute() fire-and-forget 链路里,不得因此阻塞注册。
 */
export function lookupGeo(ip?: string | null): GeoResult {
  if (!ip) return {};
  try {
    const geo = geoip.lookup(ip.trim());
    if (!geo) return {};
    return {
      country: geo.country || undefined,
      city: geo.city || undefined,
    };
  } catch {
    return {};
  }
}
