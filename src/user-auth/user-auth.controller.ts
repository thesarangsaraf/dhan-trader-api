import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserAuthService } from './user-auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto, UserRole } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';
import { UserAuthGuard } from './user-auth.guard';
import { RolesGuard } from './roles.guard';

@ApiTags('User Auth')
@Controller('api/user-auth')
export class UserAuthController {
  constructor(private readonly userAuthService: UserAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Authenticate user with username and password' })
  @ApiResponse({ status: 200, description: 'JWT Access token & persistent Refresh token issued' })
  @ApiResponse({ status: 401, description: 'Invalid username or password' })
  async login(
    @Body() dto: LoginDto,
    @Headers('user-agent') userAgent?: string,
    @Req() req?: any,
  ) {
    const clientIp = req?.headers?.['x-forwarded-for']?.toString().split(',')[0].trim() || req?.socket?.remoteAddress || '127.0.0.1';
    return this.userAuthService.login(dto, userAgent, clientIp);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refresh short-lived JWT access token using long-lived refresh token' })
  @ApiResponse({ status: 200, description: 'New JWT access token issued' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(@Body() dto: RefreshTokenDto, @Headers('user-agent') userAgent?: string) {
    return this.userAuthService.refreshToken(dto, userAgent);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke active refresh token session' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  async logout(@Body() dto: Partial<RefreshTokenDto>) {
    return this.userAuthService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(UserAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get profile information of current authenticated user' })
  @ApiResponse({ status: 200, description: 'Current user profile' })
  async getProfile(@Req() req: any) {
    const username = req.user?.username || req.user?.sub;
    if (!username) throw new UnauthorizedException('User identity missing from token');
    return this.userAuthService.getProfile(username);
  }

  @Put('password')
  @UseGuards(UserAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change current user password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Current password invalid' })
  async changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    const username = req.user?.username || req.user?.sub;
    if (!username) throw new UnauthorizedException('User identity missing from token');
    return this.userAuthService.changePassword(username, dto);
  }

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Check user authentication module readiness' })
  @ApiResponse({ status: 200, description: 'User auth readiness state' })
  async getStatus() {
    const sarang = await this.userAuthService.getUser('sarang');
    return {
      configured: !!sarang,
      superuserConfigured: !!sarang,
    };
  }

  // =========================================================================
  // ACTIVE SESSION MANAGEMENT (Self)
  // =========================================================================

  @Get('sessions')
  @UseGuards(UserAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions for current authenticated user' })
  @ApiResponse({ status: 200, description: 'List of active sessions' })
  async getMySessions(@Req() req: any, @Headers('x-refresh-token') currentRefreshToken?: string) {
    const username = req.user?.username || req.user?.sub;
    if (!username) throw new UnauthorizedException('User identity missing from token');
    return this.userAuthService.listUserSessions(username, currentRefreshToken);
  }

  @Delete('sessions/:id')
  @UseGuards(UserAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Terminate a specific active session for current user' })
  @ApiResponse({ status: 200, description: 'Session terminated' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async revokeMySession(@Req() req: any, @Param('id') sessionId: string) {
    const username = req.user?.username || req.user?.sub;
    if (!username) throw new UnauthorizedException('User identity missing from token');
    return this.userAuthService.revokeSession(username, sessionId);
  }

  @Delete('sessions')
  @UseGuards(UserAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Terminate all other active sessions (or all) for current user' })
  @ApiResponse({ status: 200, description: 'Sessions terminated' })
  async revokeOtherSessions(
    @Req() req: any,
    @Headers('x-refresh-token') currentRefreshToken?: string,
    @Query('othersOnly') othersOnly?: string,
  ) {
    const username = req.user?.username || req.user?.sub;
    if (!username) throw new UnauthorizedException('User identity missing from token');
    if (othersOnly === 'true' && currentRefreshToken) {
      return this.userAuthService.revokeOtherSessions(username, currentRefreshToken);
    }
    return this.userAuthService.revokeAllSessionsForUser(username);
  }

  // =========================================================================
  // USER CRUD OPERATIONS (Restricted strictly to role 'admin' via @Roles annotation)
  // =========================================================================

  @Get('users')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all users (Restricted to role: admin)' })
  @ApiResponse({ status: 200, description: 'List of users with roles and metadata' })
  @ApiResponse({ status: 403, description: 'Access denied: requires admin role' })
  async listUsers() {
    return this.userAuthService.listUsers();
  }

  @Post('users')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new user (Restricted to role: admin)' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 403, description: 'Access denied: requires admin role' })
  @ApiResponse({ status: 409, description: 'Username already exists' })
  async createUser(@Body() dto: CreateUserDto) {
    return this.userAuthService.createUser(dto);
  }

  @Put('users/:username')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update an existing user role or password (Restricted to role: admin)' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 403, description: 'Access denied: requires admin role' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateUser(
    @Param('username') username: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.userAuthService.updateUser(username, dto);
  }

  @Delete('users/:username')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a user (Restricted to role: admin; cannot delete superuser sarang)' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 400, description: 'Cannot delete superuser sarang' })
  @ApiResponse({ status: 403, description: 'Access denied: requires admin role' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteUser(@Param('username') username: string) {
    return this.userAuthService.deleteUser(username);
  }

  // =========================================================================
  // USER ACTIVE SESSIONS MANAGEMENT (Restricted strictly to role 'admin' via @Roles annotation)
  // =========================================================================

  @Get('all-sessions')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all active sessions across all users (Restricted to role: admin)' })
  @ApiResponse({ status: 200, description: 'List of all active sessions' })
  @ApiResponse({ status: 403, description: 'Access denied: requires admin role' })
  async getAllSessions(@Headers('x-refresh-token') currentRefreshToken?: string) {
    return this.userAuthService.listAllActiveSessions(currentRefreshToken);
  }

  @Get('users/:username/sessions')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions for specified user (Restricted to role: admin)' })
  @ApiResponse({ status: 200, description: 'List of active sessions for user' })
  @ApiResponse({ status: 403, description: 'Access denied: requires admin role' })
  async getUserSessions(@Param('username') username: string) {
    return this.userAuthService.listUserSessions(username);
  }

  @Delete('users/:username/sessions/:id')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Terminate a specific active session for user (Restricted to role: admin)' })
  @ApiResponse({ status: 200, description: 'Session terminated' })
  @ApiResponse({ status: 403, description: 'Access denied: requires admin role' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async revokeUserSession(
    @Param('username') username: string,
    @Param('id') sessionId: string,
  ) {
    return this.userAuthService.revokeSession(username, sessionId);
  }

  @Delete('users/:username/sessions')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Terminate all active sessions for user (Restricted to role: admin)' })
  @ApiResponse({ status: 200, description: 'All sessions terminated' })
  @ApiResponse({ status: 403, description: 'Access denied: requires admin role' })
  async revokeAllUserSessions(@Param('username') username: string) {
    return this.userAuthService.revokeAllSessionsForUser(username);
  }
}
