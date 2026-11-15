import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { UserAuthController } from './user-auth.controller';
import { UserAuthService } from './user-auth.service';
import { UserAuthGuard } from './user-auth.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [FirestoreModule],
  controllers: [UserAuthController],
  providers: [UserAuthService, UserAuthGuard, RolesGuard],
  exports: [UserAuthService, UserAuthGuard, RolesGuard],
})
export class UserAuthModule {}
