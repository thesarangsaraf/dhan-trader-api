import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../user-auth/public.decorator';
import { WebhooksService } from './webhooks.service';
import { DhanWebhookDto } from './dto/dhan-webhook.dto';

@ApiTags('Webhooks')
@Controller('api/webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('dhan')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dhan HQ postback webhook endpoint for alert and order execution notifications',
    description:
      'Receives HTTP POST payloads from DhanHQ when an alert condition triggers or an attached order status updates (TRADED, PENDING, REJECTED), extracts key execution metrics, and immediately dispatches a formatted notification to Telegram.',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully and Telegram notification evaluated' })
  async handleDhanWebhook(
    @Body() dto: DhanWebhookDto,
    @Headers('content-type') contentType?: string,
  ) {
    return this.webhooksService.handleDhanWebhook(dto, { contentType });
  }
}

