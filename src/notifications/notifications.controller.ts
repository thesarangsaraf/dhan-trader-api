import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { NotificationsService, NotificationSettingsSummary } from './notifications.service';
import { NtfyService } from './ntfy.service';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';
import { NtfyTestDto } from './dto/ntfy-test.dto';
import { Roles } from '../user-auth/roles.decorator';
import { UserRole } from '../user-auth/dto/create-user.dto';

@ApiTags('Notifications')
@Controller('api')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly ntfyService: NtfyService,
  ) {}

  @Get('notifications/settings')
  @ApiOperation({
    summary: 'Get notification channels configuration (Telegram & ntfy.sh) and active toggles',
    description: 'Returns active status, configured parameters, and enabled/disabled state for Telegram and ntfy.sh from Firestore.',
  })
  @ApiResponse({ status: 200, description: 'Notification settings returned successfully' })
  async getSettings(): Promise<NotificationSettingsSummary> {
    return this.notificationsService.getSettings();
  }

  @Put('notifications/settings')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Update notification channels toggles and parameters in Firestore (Admin only)',
    description: 'Enables or disables Telegram / ntfy.sh postback updates, or updates the ntfy.sh topic name and server URL.',
  })
  @ApiResponse({ status: 200, description: 'Notification settings updated and saved to Firestore database' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can update notification settings' })
  async updateSettings(@Body() dto: UpdateNotificationSettingsDto): Promise<{
    success: boolean;
    message: string;
    settings: NotificationSettingsSummary;
  }> {
    const updated = await this.notificationsService.updateSettings(dto);
    return {
      success: true,
      message: 'Notification channel settings updated and saved to Firestore',
      settings: updated,
    };
  }

  @Post('notifications/test')
  @ApiOperation({
    summary: 'Send test verification notifications across all enabled notification channels',
    description: 'Dispatches test messages to Telegram and/or ntfy.sh depending on which channels are enabled in settings.',
  })
  @ApiResponse({ status: 200, description: 'Dispatched test notifications' })
  async sendTestNotifications() {
    return this.notificationsService.sendTestNotification();
  }

  @Get('ntfy/status')
  @ApiOperation({ summary: 'Get ntfy.sh connection and subscription status' })
  @ApiResponse({ status: 200, description: 'ntfy status and subscription URL' })
  async getNtfyStatus() {
    return this.ntfyService.getStatus();
  }

  @Post('ntfy/test')
  @ApiOperation({ summary: 'Send test notification to configured ntfy.sh topic' })
  @ApiResponse({ status: 200, description: 'Dispatch result to ntfy.sh' })
  async sendNtfyTest(@Body() dto: NtfyTestDto) {
    return this.ntfyService.sendTestNotification(dto?.topic);
  }
}
