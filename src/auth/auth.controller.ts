import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { UpdateTokenDto } from './dto/update-token.dto';
import { Roles } from '../user-auth/roles.decorator';
import { UserRole } from '../user-auth/dto/create-user.dto';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get token inspection & IST expiry status' })
  @ApiResponse({ status: 200, description: 'JWT decoded payload and IST countdown' })
  getStatus() {
    return this.authService.getTokenInspection();
  }

  @Get('verify')
  @ApiOperation({ summary: 'Verify live validity against Dhan API profile' })
  @ApiResponse({ status: 200, description: 'Live verification result' })
  async verify() {
    return this.authService.verifyLiveValidity();
  }

  @Post('renew')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Renew Dhan Access Token via Dhan API (Admin only)' })
  @ApiResponse({ status: 200, description: 'Renewal outcome' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can renew broker token' })
  async renew() {
    const res = await this.authService.renewToken();
    if (!res.success) {
      throw new BadRequestException(res.error || 'Dhan token renewal rejected by Dhan API');
    }
    return res;
  }

  @Post('update')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update token manually without restarting server (Admin only)' })
  @ApiResponse({ status: 200, description: 'Token updated and saved' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can update broker credentials' })
  update(@Body() dto: UpdateTokenDto) {
    return this.authService.updateToken(dto.token, dto.clientId);
  }
}
