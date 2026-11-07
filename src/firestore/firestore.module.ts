import { Global, Module } from '@nestjs/common';
import { FirestoreService } from './firestore.service';
import { FirestoreController } from './firestore.controller';

@Global()
@Module({
  controllers: [FirestoreController],
  providers: [FirestoreService],
  exports: [FirestoreService],
})
export class FirestoreModule {}
