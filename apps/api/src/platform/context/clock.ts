import { Injectable } from '@nestjs/common';

/** Source of the current time; replaced in tests for deterministic timestamps. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
