import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { buildMikroOrmConfig } from "./database/mikro-orm.config.ts";
import { HealthModule } from "./health/health.module.ts";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => buildMikroOrmConfig("app"),
    }),
    HealthModule,
  ],
})
export class AppModule {}
