import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { UserJwtUtil } from './utils/user-jwt.util';
import { ConfigService } from '../config/config.service';
import { FirestoreService } from '../firestore/firestore.service';

@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly firestoreService?: FirestoreService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // 1. Check for x-cron-secret header for automated Cloud Scheduler jobs
    const incomingCronSecret = request.headers['x-cron-secret'];
    if (incomingCronSecret && typeof incomingCronSecret === 'string') {
      let activeCronSecret = this.configService?.cronSecret || process.env.CRON_SECRET;

      // Fallback check against Firestore if in-memory secret not yet populated
      if (!activeCronSecret && this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
        try {
          const cronDoc = await this.firestoreService.getCronConfig();
          if (cronDoc?.cronSecret) {
            activeCronSecret = cronDoc.cronSecret;
            if (this.configService) {
              this.configService.cronSecret = cronDoc.cronSecret;
            }
          }
        } catch {}
      }

      if (activeCronSecret && incomingCronSecret.trim() === activeCronSecret.trim()) {
        request.user = {
          userId: 'cloud-scheduler',
          username: 'cloud-scheduler',
          role: 'admin',
        };
        return true;
      }
    }

    const authHeader = request.headers['authorization'];

    // In automated testing environments, pass through if no auth header was provided
    if (process.env.NODE_ENV === 'test' && !authHeader) {
      return true;
    }

    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException('Authentication required. Missing Bearer token.');
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization scheme. Bearer token required.');
    }

    const payload = UserJwtUtil.verify(token);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    request.user = payload;
    return true;
  }
}
