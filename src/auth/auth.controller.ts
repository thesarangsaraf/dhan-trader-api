import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { UpdateTokenDto } from './dto/update-token.dto';

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
  @ApiOperation({ summary: 'Renew Dhan Access Token via Dhan API' })
  @ApiResponse({ status: 200, description: 'Renewal outcome' })
  async renew() {
    return this.authService.renewToken();
  }

  @Post('update')
  @ApiOperation({ summary: 'Update token manually without restarting server' })
  @ApiResponse({ status: 200, description: 'Token updated and saved' })
  update(@Body() dto: UpdateTokenDto) {
    return this.authService.updateToken(dto.token, dto.clientId);
  }
}
