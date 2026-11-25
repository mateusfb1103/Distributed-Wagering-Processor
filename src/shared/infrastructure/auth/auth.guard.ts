import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

export const SKIP_AUTH_KEY = "dwp:skipAuth";
export const SkipAuth = () => SetMetadata(SKIP_AUTH_KEY, true);

/**
 * Guard global no-op (D13): mantém ponto de extensão explícito para OIDC/Keycloak,
 * ignorando `/health/*` e `/metrics`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const skipAuth = this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipAuth) {
      return true;
    }
    return true;
  }
}
