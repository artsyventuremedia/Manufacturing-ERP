-- DEV ONLY (docker-compose). Production roles and passwords are provisioned by Terraform/Vault.
-- manuling_app is the application login; it receives app_rw after migrations run.
-- manuling_relay is the core-worker outbox relay login; it receives outbox_relay (reads all
-- tenants' outbox rows) and must never be used by the API.
CREATE ROLE manuling_app LOGIN PASSWORD 'manuling_app';
CREATE ROLE manuling_relay LOGIN PASSWORD 'manuling_relay';
CREATE DATABASE keycloak;
CREATE DATABASE temporal;
