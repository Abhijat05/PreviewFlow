# Testing Architecture Assessment: GitHub PR Preview Platform (PreviewFlow)

**Date**: 2026-11-22  
**Scope**: Phase 1 — Testing Infrastructure & Initial Test Coverage

---

## 1. Executive Summary

PreviewFlow provisions ephemeral Docker preview environments for GitHub Pull Requests.
Prior to this assessment:
- **Backend**: Contained 11 ad-hoc test files running via `node --test`. Several tests had unmocked database calls attempting connections to remote Supabase instances or localhost PostgreSQL, leading to hangs or failures when executed offline or in sandboxed environments without database access.
- **Frontend**: Zero test coverage. No test runner, test libraries, or test scripts were configured in `frontend/package.json`.
- **Database**: Prisma schema targeting PostgreSQL with User, Project, Preview, and PreviewMetric models. In CI, a PostgreSQL service is provisioned; locally, no fallback or isolation mechanism exists for offline unit testing.
- **Mocking & Isolation**: No centralized mock helpers existed for Prisma, Dockerode, simple-git, or Socket.IO, resulting in inconsistent test-level patching.

---

## 2. Codebase Architecture & Responsibilities

### 2.1 Backend (`backend/`)
- **Server Entry (`src/server.js`)**: Configures Express, CORS, Morgan, raw-body parser for HMAC verification, Passport GitHub OAuth, mounts API routes, initializes Socket.IO, starts the background stats worker and periodic disk cleanup.
- **Authentication & Authorization**:
  - `src/auth.js`: Passport GitHub strategy. Upserts user, sets default tier (`FREE`), attaches OAuth access token.
  - `src/middleware/auth.js`: `decodeAuth` extracts Bearer JWT and refreshes user tier directly from Prisma to prevent stale token privilege abuse. `requireAuth` populates `req.auth`, `req.user`, `req.sub`.
  - `src/middleware/tierLimits.js`: Defines quotas for FREE, HOBBY, PRO, ENTERPRISE (`maxProjects`, `maxConcurrentBuilds`, `maxPreviews`, `allowWebhooks`).
  - `src/middleware/subscription.js`: `assertRepoQuota`, `assertPreviewQuota`, port pool definitions per tier.
- **Webhook & PR Lifecycle**:
  - `src/utils/gitHubVerify.js`: Cryptographic HMAC-SHA256 signature verification.
  - `src/routes/githubWebhook.js`: Handles incoming webhook payload, matches multi-tenant candidate projects by signature, routes `opened`, `synchronize`, `reopened`, `closed` events.
  - `src/services/prHandlers.js`: `handlePROpenOrSync` upserts Preview record, clones repo, triggers `buildPreview`, broadcasts socket updates. `handlePRClosed` tears down container, frees port, marks status `deleted`.
- **Docker & Build Orchestration**:
  - `src/services/detectProjectType.js`: Inspects cloned repo files for Dockerfile, Next.js, Vite, Node backend, or static HTML; maps template and internal container port (80 or 3000).
  - `src/services/dockerClient.js`: Configures Dockerode across platforms (Unix socket vs Windows named pipe `//./pipe/docker_engine` vs TCP).
  - `src/services/dockerService.js`: Container naming (`preview-p<project>-pr<pr>-b<build>`), port allocation (`findAvailablePort` with mutex + in-memory reservation + DB check + TCP probe to eliminate TOCTOU races), `runCommand` (safe spawn execution streaming logs), `buildPreview`, and `removeContainer`.
  - `src/services/repoService.js`: `cloneRepo` using simple-git with depth 50, branch/PR-head checkout, credential scrubbing via `sanitizeGitError`, and `cleanupOrphanedBuildDirs`.
- **Realtime & Metrics**:
  - `src/socket.js`: Socket.IO initialization with JWT verification on registration. Joins `user:<userId>` and `preview:<previewId>` rooms with authorization checks.
  - `src/services/statsWorker.js`: Periodic worker polling Docker container stats for `live` / `building` previews, calculating CPU %, memory, and network I/O, broadcasting over socket and persisting every 30s to Prisma.
  - `src/services/containerStats.js`: Pure function calculating CPU %, memory usage, limits, and network delta.
- **Routes**:
  - `accountTier.js`: Tier changes (with payment validation in production).
  - `connectRepo.js`: Links GitHub repo to user, generates webhook secret, creates remote webhook on GitHub for paid tiers.
  - `createWebhook.js`: Manual webhook creation for PRO/ENTERPRISE.
  - `devSimulate.js`: Simulation route (`/dev/sim-pr`) strictly disabled in production.
  - `githubRepos.js`: Lists user repositories from GitHub API.
  - `logs.js`: Retrieves stored build logs.
  - `previewActions.js`: `handleRebuildPreview` (asynchronous 202 Accepted with tier build-limit check) and `handleDeletePreview`.
  - `previewMetrics.js`: Historical telemetry retrieval with 1h/24h filtering.
  - `projects.js` & `projectDashboard.js`: User project and preview listings.
  - `user.js`: User profile retrieval (`/api/user/me`).

### 2.2 Database (`backend/prisma/schema.prisma`)
- Models: `User`, `Project`, `Preview`, `PreviewMetric`.
- Enums: `UserTier` (`FREE`, `HOBBY`, `PRO`, `ENTERPRISE`).
- Key Constraints: Unique `[projectId, prNumber]` on `Preview`, unique `githubId` on `User`, cascade deletes on Project -> Preview -> PreviewMetric.
- Indexes on `[userId]`, `[repoOwner, repoName]`, `[status]`, `[port]`, `[previewId, createdAt]`.

### 2.3 Frontend (`frontend/`)
- **Framework**: React 19, Vite 7, Tailwind CSS, Lucide Icons, Framer Motion, Recharts.
- **Routing & State**: `react-router-dom` v7 with lazy route splitting. `AuthProvider` handles token persistence, fallback tier parsing, and `/api/user/me` sync. `SocketProvider` establishes WebSocket and room management.
- **Pages**:
  - `LandingPage`: Public marketing page.
  - `Dashboard`: Lists user projects, preview cards, status badges, live timers, resource monitors, rebuild and delete actions.
  - `ConnectRepo`: Search GitHub repos, connect project, enforce tier quotas.
  - `Logs`: Real-time streaming log terminal with ANSI highlighting, auto-scroll, and socket/polling fallbacks.
  - `PreviewMetrics`: Live and historical telemetry charts (CPU, RAM, Network, Uptime).
  - `Pricing`: Tier comparison and plan selection.
  - `AuthSuccess`: Captures OAuth token from redirect URL into localStorage.
- **Components & Hooks**:
  - `MonitoringPanel`: Recharts area charts with range selector (1h/24h) and peak stat cards.
  - `ResourceMonitor`: Minimalist CPU and RAM progress bars.
  - `usePreviewStats`: Custom hook managing historical API fetch and real-time socket delta merging.
  - `api.js`: Axios instance with request Bearer token injection and 401 response auto-logout interceptor.

---

## 3. Current Testing Gaps

1. **Backend Unit Testing**:
   - `repoService`: No comprehensive tests for checkout failures, fallback to default branch, or cleanup on checkout error.
   - `dockerService`: No unit tests for complete `buildPreview` flow, port conflict resolution, or build log capture under mocked child_process.
   - `prHandlers`: Completely untested in isolation (`handlePROpenOrSync`, `handlePRClosed`).
   - `statsWorker`: Untested polling loop, listener skipping optimization, and database persistence logic.
   - `containerStats`: Untested missing fields, zero system delta, and error handling.
2. **Backend Route Integration Testing**:
   - Existing tests mixed unit mocking with unmocked database calls.
   - No structured Express route testing using Supertest.
   - Missing integration tests for `/api/projects`, `/api/user/me`, `/preview/:id/logs`, `/api/previews/:id/metrics`.
3. **Database Integration Testing**:
   - Tests failed when PostgreSQL was not running locally because there was no isolation harness to detect environment availability or validate database isolation.
4. **Socket.IO Realtime Testing**:
   - Current socket tests created a standalone mock socket server instead of testing the actual `initSocket` and `getIO` implementations from `src/socket.js`.
5. **Frontend Testing**:
   - 100% gap. No test runner, no component tests, no hook tests.
6. **CI Workflow**:
   - Frontend CI only ran `lint` and `build` — did not execute any tests.

---

## 4. Tool Selection & Architecture Rationale

| Layer | Selected Tool | Rationale |
|---|---|---|
| **Backend Test Runner** | Node.js Test Runner (`node:test`, `node:assert/strict`) | Built into Node.js 20+ (already used by existing 11 test files), zero dependency overhead, fast startup, built-in mock module (`mock.fn`, `mock.method`, `mock.timers`). |
| **Backend Route Testing** | `supertest` | De-facto standard for Express route testing without port-binding conflicts or manual HTTP server lifecycles. |
| **Frontend Test Runner** | `vitest` | First-party Vite integration, reads `vite.config.js` aliases, native ESM and JSX support, blazing fast. |
| **Frontend Component Testing** | `@testing-library/react` + `@testing-library/jest-dom` + `jsdom` | Standard user-centric testing library for React 19 components without coupling to implementation details. |
| **Database Isolation** | Isolated Test Database Harness | Validates test environment (`previewflow_test` / `NODE_ENV=test`), protects production databases, isolates transactions. |

---

## 5. Next Steps

Proceed with Step 3 & 4 of implementation: configuring test runners, building reusable mocks, and implementing tests in logical increments according to the mandatory sequence.
