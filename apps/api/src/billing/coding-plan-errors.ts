import { BadRequestException } from '@nestjs/common';

/**
 * 自营 CodingPlan(platform_model_package) 换档抵扣「安全闸」拒单：履约阶段发现本订单携带的抵扣额
 * 所依据的源 entitlement 已失效（并发被切走 / 切走再切回同档 / 源已到期 / 源 id 缺失）。
 *
 * 这是**永久性业务拒绝**（非瞬时故障，重试也不会成功），用独立类型与 DB/网络等瞬时异常区分：
 * 支付后履约命中它时，编排层据此对「已支付」订单执行自动全额退款（而非仅标 FAILED 等人工处理），
 * 从而不让用户付款却既无履约、又无退款。瞬时故障仍走 FAILED + 告警重试路径。
 */
export class SelfOpProrationSourceInvalidError extends BadRequestException {
  constructor(
    message = '换档抵扣来源已失效（原套餐已被切换或到期），本次抵扣无效；订单将标记失败并退款，请重新下单。',
  ) {
    super(message);
  }
}
