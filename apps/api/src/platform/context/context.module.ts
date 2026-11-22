import { Global, Module } from '@nestjs/common';
import { Clock } from './clock';
import { TxRunner } from './tx-runner';

@Global()
@Module({
  providers: [Clock, TxRunner],
  exports: [Clock, TxRunner],
})
export class ContextModule {}
