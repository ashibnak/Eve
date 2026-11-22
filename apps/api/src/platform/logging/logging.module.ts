import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Never log credentials. Sensitive business fields must not reach logs either (CLAUDE.md rule 13).
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          censor: '[redacted]',
        },
        autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      },
    }),
  ],
})
export class LoggingModule {}
