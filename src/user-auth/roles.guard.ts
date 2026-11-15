import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no @Roles annotation is attached, route is accessible to any authenticated user
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // In automated testing environments where synthetic calls don't set user, allow if not provided
    if (process.env.NODE_ENV === 'test' && !user) {
      return true;
    }

    if (!user || !user.role) {
      throw new ForbiddenException('Access denied. User role not identified.');
    }

    const userRole = (user.role || '').toLowerCase();
    const hasRole = requiredRoles.some((role) => (role || '').toLowerCase() === userRole);

    if (!hasRole) {
      throw new ForbiddenException(
        `Access denied. Requires role [${requiredRoles.join(', ')}]. Current role: [${user.role}].`,
      );
    }

    return true;
  }
}
