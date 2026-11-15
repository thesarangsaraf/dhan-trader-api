import { SetMetadata } from '@nestjs/common';
import { UserRole } from './dto/create-user.dto';

export const ROLES_KEY = 'roles';

/**
 * Annotation / Decorator to enforce Role-Based Access Control (RBAC) on REST API endpoints.
 * Applied at the controller or route handler level.
 *
 * Examples:
 *   @Roles(UserRole.ADMIN)
 *   @Roles('admin', 'trader')
 */
export const Roles = (...roles: (UserRole | string)[]) => SetMetadata(ROLES_KEY, roles);
