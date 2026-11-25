import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { loadEnv } from "./shared/infrastructure/config/env.ts";

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  if (env.APP_ROLES.includes("api")) {
    const app = await NestFactory.create(AppModule, {
      logger: ["error", "warn"],
    });
    app.enableShutdownHooks();
    await app.listen(env.PORT);
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });
  app.enableShutdownHooks();
}

if (import.meta.main) {
  await bootstrap();
}
