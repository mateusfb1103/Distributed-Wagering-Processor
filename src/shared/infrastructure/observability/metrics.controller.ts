import { Controller, Get, Header, Inject } from "@nestjs/common";
import { SkipAuth } from "../auth/auth.guard.ts";
import { MetricsService } from "./metrics.service.ts";

@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Get()
  @SkipAuth()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async getMetrics(): Promise<string> {
    return this.metrics.renderPrometheus();
  }
}
