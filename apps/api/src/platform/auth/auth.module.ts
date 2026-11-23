import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { UsersController } from './users.controller';

@Global()
@Module({
  controllers: [AuthController, UsersController],
  providers: [AuthService, UserService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService, UserService],
})
export class AuthModule {}
