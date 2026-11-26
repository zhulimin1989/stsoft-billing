/**
 * ReferralsUserController — 用户端获取自己的邀请码。
 *
 * 路由 /api/user/referral-code (沿用既有 user 命名空间)。
 * billing runtime 已注册全局用户鉴权 guard,@CurrentUser 拿当前登录用户。
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReferralsService } from './referrals.service';

@ApiTags('User / Referrals')
@Controller('user')
export class ReferralsUserController {
  constructor(private readonly service: ReferralsService) {}

  @Get('referral-code')
  async getMyReferralCode(
    @CurrentUser('id') userId: string,
    @Query('programId') programId?: string,
  ): Promise<ApiResponse<{ code: string; programId: string }>> {
    const data = await this.service.getMyReferralCode(
      userId,
      programId?.trim() || undefined,
    );
    return { code: 0, message: 'ok', data };
  }
}
