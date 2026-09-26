# Manuling

AI-native manufacturing ERP by Artsy Technologies Pvt. Ltd.

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Architecture and decisions: [docs/architecture](docs/architecture/README.md), [docs/adr](docs/adr/README.md)
- Progress: [docs/STATUS.md](docs/STATUS.md)

## Quick start

Requirements: Node.js 24, pnpm 11. Docker is optional for tests; the dev stack needs Docker Desktop, OrbStack, or Colima (`colima start --vm-type vz --cpu 4 --memory 8`, no admin rights needed).

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm test:integration        # real PostgreSQL (embedded binaries): RLS, ledgers, API
```

Run the API against the local stack:

```sh
cp .env.example .env         # then export the variables, or use direnv
pnpm dev:stack               # Postgres, Kafka, Temporal, Keycloak, Valkey, SeaweedFS, Grafana
pnpm --filter @manuling/core migrate        # uses DATABASE_ADMIN_URL, APP_DB_USER, RELAY_DB_USER
pnpm --filter @manuling/core seed:demo -- --admin-sub 5d1b1f0e-3a6c-4c55-9d7e-0f6d9a2b7c11
pnpm --filter @manuling/core dev            # API on :3000
pnpm --filter @manuling/core dev:worker     # outbox relay → Kafka (EVENT_BUS=kafka)
curl localhost:3000/health/ready   # authenticated calls: see infra/keycloak/README.md
```

API contract: `GET /openapi.json` (also committed at [docs/api/openapi.json](docs/api/openapi.json)).
