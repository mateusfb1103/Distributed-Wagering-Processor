import { Global, Module } from "@nestjs/common";
import { UuidV7Generator } from "../domain/id-generator.ts";
import {
  DevProviderIdentityAdapter,
  ProviderIdentityPort,
} from "./auth/provider-identity.port.ts";
import { AppLogger } from "./observability/logger.service.ts";
import { MetricsController } from "./observability/metrics.controller.ts";
import { MetricsService } from "./observability/metrics.service.ts";

export const ID_GENERATOR = Symbol("ID_GENERATOR");

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    AppLogger,
    MetricsService,
    {
      provide: ID_GENERATOR,
      useClass: UuidV7Generator,
    },
    {
      provide: ProviderIdentityPort,
      useClass: DevProviderIdentityAdapter,
    },
  ],
  exports: [AppLogger, MetricsService, ID_GENERATOR, ProviderIdentityPort],
})
export class SharedInfraModule {}
