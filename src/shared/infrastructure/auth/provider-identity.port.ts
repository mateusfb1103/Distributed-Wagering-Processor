import { Injectable } from "@nestjs/common";

export interface ProviderIdentity {
  readonly providerId: string;
}

export abstract class ProviderIdentityPort {
  abstract resolveFromBody(bodyProviderId: string): ProviderIdentity;
}

/**
 * Implementação de desenvolvimento (D13): confia no `providerId` informado no payload.
 * Ponto de extensão previsto para extração via JWT/OIDC (Keycloak) na evolução futura.
 */
@Injectable()
export class DevProviderIdentityAdapter extends ProviderIdentityPort {
  override resolveFromBody(bodyProviderId: string): ProviderIdentity {
    return { providerId: bodyProviderId };
  }
}
