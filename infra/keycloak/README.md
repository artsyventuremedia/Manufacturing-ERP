# Keycloak (development realm)

`realm-manuling.json` is imported by `pnpm dev:stack` (`start-dev --import-realm`). **Dev only:** it contains a demo password and a password-grant client.

| Item                           | Value                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Issuer (`OIDC_ISSUER`)         | `http://localhost:8080/realms/manuling`                                               |
| API audience (`OIDC_AUDIENCE`) | `manuling-api` (added to access tokens by an audience mapper)                         |
| Web client                     | `manuling-web` (public, Authorization Code + PKCE S256)                               |
| Demo user                      | `demo.admin` / `Demo-Admin-2026!`, Keycloak id `5d1b1f0e-3a6c-4c55-9d7e-0f6d9a2b7c11` |

Seed the matching Manuling workspace and call the API:

```sh
pnpm --filter @manuling/core seed:demo -- --admin-sub 5d1b1f0e-3a6c-4c55-9d7e-0f6d9a2b7c11
TOKEN=$(curl -s -d grant_type=password -d client_id=manuling-dev-cli \
  -d username=demo.admin -d 'password=Demo-Admin-2026!' \
  http://localhost:8080/realms/manuling/protocol/openid-connect/token | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" -H 'X-Tenant: mysuru-precision' localhost:3000/v1/platform/me
```

Tenancy is not taken from token claims (ADR-0013). Keycloak Organizations are used for per-tenant enterprise SSO brokering, while workspace membership lives in `platform.app_user`.
