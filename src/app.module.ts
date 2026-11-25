import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { buildMikroOrmConfig } from "./database/mikro-orm.config.ts";
import { HealthModule } from "./health/health.module.ts";
import { ReconciliationModule } from "./reconciliation/reconciliation.module.ts";
import { AuthGuard } from "./shared/infrastructure/auth/auth.guard.ts";
import { CorrelationIdMiddleware } from "./shared/infrastructure/http/correlation-id.middleware.ts";
import { GlobalHttpExceptionFilter } from "./shared/infrastructure/http/http-exception.filter.ts";
import { SharedInfraModule } from "./shared/infrastructure/shared-infra.module.ts";
import { WageringModule } from "./wagering/wagering.module.ts";
import { WalletModule } from "./wallet/wallet.module.ts";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => buildMikroOrmConfig("app"),
    }),
    SharedInfraModule,
    HealthModule,
    WalletModule,
    WageringModule,
    ReconciliationModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalHttpExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes("*");
  }
}
