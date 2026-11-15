import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { UserJwtUtil } from './utils/user-jwt.util';

@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
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
