# Plan: Cerebo (client and project workspace)

## Goal
Add a thin project-management layer to the portal. Cerebo knows which projects
each client has, their milestones, and where the work for each project lives in
Nextcloud. Nextcloud stays the system of record for collaboration (tasks, files,
docs, chat, contacts); the portal stays the system of record for clients and
billing. Cerebo stores only what neither of them can: project and milestone
records and the links between them and Nextcloud.

## Current State
- `clients` and `client_groups` already hold each client's identity, contacts
  and Stripe ids. Cerebo reuses them instead of adding an organization table.
- Operators sign in with an admin JWT (`requireAdminJwt`); every admin sees every
  client. Clients have no human login, only API keys for their integration.
- Nextcloud (`cloud.dfwsc.com`, 35.0.2) exposes Deck, Files/WebDAV, Talk,
  Collectives, Tables, Contacts and Calendar over REST, OCS and DAV.
- An earlier prototype (`feat/cerebo-foundation`, never pushed) modelled
  tenants, memberships, organizations, people and tasks. Those duplicate
  `clients`, Deck and Contacts, so only its patterns carry over: composite
  foreign keys, transactional audit writes and the isolation tests.

## Ownership

| Data | System of record | Cerebo stores |
|---|---|---|
| Client / organization | Portal `clients` | nothing new |
| Billing | Stripe + portal | optional invoice id on a milestone |
| Projects | Cerebo | `cerebo.projects` |
| Milestones | Cerebo | `cerebo.milestones` |
| Tasks and tickets | Nextcloud Deck | board id, read live |
| Files and deliverables | Nextcloud Files | folder id and path |
| Knowledge | Nextcloud Collectives | collective or page id |
| Conversation | Nextcloud Talk | room token |
| Contacts | Nextcloud Contacts | vCard uid |
| Audit | Split | business changes in `cerebo.audit_events`; Nextcloud keeps its own activity |

Milestones stay in Postgres rather than in Tables or Deck because they are what
clients will see and what invoices tie to, so they need real foreign keys.

## Data model
Postgres schema `cerebo`, four tables. Every row carries `client_id`
(referencing `clients.id`), and every reference between Cerebo rows is a
composite `(client_id, id)` foreign key, so the database refuses a link that
crosses clients even if a query forgets to filter.

- `projects`: name, description, status, start/end dates.
- `milestones`: project, title, status, due date, completed time,
  `client_visible`, optional `stripe_invoice_id`, sort order.
- `resource_links`: kind (`deck_board`, `files_folder`, `talk_room`,
  `collective`, `contact`, `calendar`), external id, url, label; belongs to a
  client and optionally a project.
- `audit_events`: actor, action, entity, field-level changes, request id;
  written in the same transaction as the change.

## Phases

### Phase 1: backend foundation (this branch)
- Migration and schema for the four tables.
- Services and admin-only routes under `/api/v1/cerebo`, served only when
  `CEREBO_ENABLED=true`.
- Nextcloud adapter (`NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`,
  `NEXTCLOUD_APP_PASSWORD`) with a request timeout and its own circuit breaker,
  so a Nextcloud outage degrades the project view instead of failing it, and
  never touches payments. Phase 1 reads Deck board progress only.
- Integration tests: cross-client isolation, audit records, validation, the
  feature flag, and Deck degradation.

### Phase 2: provisioning
"New project" creates the Deck board, `clients/<client>/<project>` folder, Talk
room and Collectives page, recording each as a resource link. Re-running is
safe; a partial failure reports what is missing and can be retried.

### Phase 3: operator dashboard
`/admin/cerebo`: clients, their projects and milestones, live Deck progress and
links into Nextcloud. Built on the studio styles from PR #174, so it starts
after #174 merges.

### Phase 4: client portal
Emailed one-time-link sign-in through the existing mailer; read-only view of a
client's projects, client-visible milestones, invoice status and shared file
links. Clients do not need Nextcloud accounts.

### Later
Search across projects and Nextcloud; MCP tools over the same services.

## Prerequisites
- A Nextcloud service account (for example `cerebo-bot`) with an app password,
  and the relevant Deck boards shared with it.
- `CEREBO_ENABLED` and the three `NEXTCLOUD_*` variables set in Coolify for the
  API when Phase 1 is deployed.
