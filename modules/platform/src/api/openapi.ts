import { type OpenAPIRegistry } from '@manuling/http';
import { registerAuditOpenApi } from './audit.controller.js';
import { registerAuthorisationOpenApi } from './authorisation.dto.js';
import { registerOrganisationOpenApi } from './dto.js';
import { registerNumberingOpenApi } from './numbering.controller.js';

/**
 * All Platform OpenAPI paths. Kept separate from the DTO files so controllers can import
 * shared DTOs without creating import cycles.
 */
export function registerPlatformOpenApi(registry: OpenAPIRegistry): void {
  registerOrganisationOpenApi(registry);
  registerAuthorisationOpenApi(registry);
  registerAuditOpenApi(registry);
  registerNumberingOpenApi(registry);
}
