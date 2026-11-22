# Testing Guide & Documentation

This document describes the testing architecture, runner configuration, mocking strategies, test isolation mechanisms, and execution instructions for the **GitHub PR Preview Platform (PreviewFlow)**.

---

## 1. Architecture Overview

The testing foundation uses standard, modern, and lightweight tooling tailored to the application's runtime environments:

| Area | Runner / Framework | Target Files | Key Libraries |
|---|---|---|---|
| **Backend Services & API** | Node.js Native Test Runner (`node:test`) | `backend/tests/**/*.test.js` | `node:test`, `node:assert`, `supertest` |
| **Backend Database** | Isolated Integration Tests | `backend/tests/integration/database.integration.test.js` | Prisma Client, PostgreSQL |
| **Backend Webhooks & Socket** | Native Integration Suites | `backend/tests/integration/*.test.js` | `supertest`, `socket.io-client`, `crypto` |
| **Frontend Components & Hooks**| Vitest + React Testing Library | `frontend/src/tests/**/*.{test.js,test.jsx}` | `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom` |

### Why This Tooling?
- **Backend (`node:test`)**: Zero external runner dependencies for the backend. Built directly into Node.js 20.x & 22.x, executes asynchronously with sub-second startup overhead and native ESM support.
- **API Testing (`supertest`)**: Mounts Express application handlers directly without binding to physical public ports or interfering with production web workers.
- **Frontend (`vitest`)**: Integrates seamlessly with the project's existing Vite 7 pipeline, sharing path aliases (`@`), JSX transformations, and Tailwind styling environments with JSDOM emulation.

---

## 2. Directory Structure

```
pr-review/
├── .github/
│   └── workflows/
│       └── ci.yml                            # Multi-job CI pipeline (frontend, backend, docker, ci-status)
├── backend/
│   ├── package.json                          # "test": "node --test"
│   └── tests/
│       ├── helpers/
│       │   ├── authHelper.js                 # JWT generation and mock user fixtures
│       │   └── prismaMock.js                 # Model method stubbing for isolated unit tests
│       ├── unit/
│       │   ├── containerStats.test.js        # 4.5 Container metrics calculations & CPU deltas
│       │   ├── dockerService.test.js         # 4.2 Docker name sanitization, port pool, command runner
│       │   ├── prHandlers.test.js            # 4.3 PR opened/synced/closed lifecycle orchestration
│       │   ├── repoService.test.js           # 4.1 Git clone URL sanitization, disk cleanup, token scrubbing
│       │   ├── statsWorker.test.js           # 4.4 Background telemetry poller & DB persistence interval
│       │   └── tierLimits.test.js            # 4.6 Tier quotas (FREE, HOBBY, PRO, ENTERPRISE) & builds
│       ├── integration/
│       │   ├── authRoutes.test.js            # 5.1 /health, /api/user/me, JWT schemes, expired tokens
│       │   ├── database.integration.test.js  # 6. Prisma CRUD, cascade relations, production safeguard
│       │   ├── githubWebhook.test.js         # 5.2 HMAC signatures, PR opened/sync/closed HTTP routes
│       │   ├── previewActions.test.js        # 5.3 /api/preview/:id/rebuild, /delete, authorization
│       │   ├── projectRoutes.test.js         # 5.4 /api/projects, /api/preview/:id/logs, dev simulation
│       │   └── socket.test.js                # 7. Socket.IO connection, room join/leave, live telemetry
│       └── e2e/
│           └── workflows.test.js             # 9. Workflows A (Open->Build->View), B (Failure), C (Close), D (Telemetry)
└── frontend/
    ├── vite.config.js                        # Vitest configuration with jsdom & setupFiles
    └── src/
        ├── test/
        │   └── setup.js                      # DOM cleanup, window.matchMedia mock
        └── tests/
            ├── auth.test.jsx                 # AuthContext login, logout, token persistence, tier states
            ├── ConnectRepo.test.jsx          # 8. GitHub repository selection, search filter, import flow
            ├── Dashboard.test.jsx            # 8. Project cards, status badges, rebuild/delete actions
            ├── Logs.test.jsx                 # 8. Terminal viewer, error highlighting, copy to clipboard
            ├── metrics.test.js               # Metric utilities: byte formatting, CPU delta math
            ├── ResourceMonitor.test.jsx      # Resource monitor gauges, warning thresholds, click handlers
            └── usePreviewStats.test.jsx      # Telemetry hook, Socket.IO live updates, disconnect handling
```

---

## 3. Mocking & Isolation Strategies

### 3.1 Database Isolation & Production Safeguards
Unit tests and route tests run without touching any live database.
- **`prismaMock.js`**: Replaces Prisma client delegates (`user`, `project`, `preview`, `previewMetric`) with in-memory sinon/vitest-compatible mock functions.
- **Production Guard (`database.integration.test.js`)**: Before executing real PostgreSQL tests, the suite inspects `process.env.DATABASE_URL`. If the URL points to Supabase or any production domain, or if a local test database is unreachable, the suite **skips cleanly** rather than mutating data or crashing.

### 3.2 Docker Daemon Mocking
Unit and route tests never execute real Docker containers:
- `dockerService.runCommand` is stubbed using Node child_process mocks or custom command runners to verify command construction and ensure input sanitization against shell injection.
- Port allocation logic (`isPortFree`, `findAvailablePort`) is verified using in-memory port reservation sets to guard against TOCTOU race conditions.

### 3.3 GitHub API & Webhooks
- Webhook signature tests calculate valid HMAC SHA-256 signatures using `crypto.createHmac('sha256', secret)` with test payloads.
- Repository cloning (`cloneRepo`) is decoupled via parameter injection so no network requests are dispatched to GitHub during test runs.

### 3.4 Socket.IO Realtime Communications
- Backend integration tests spin up ephemeral loopback `http.createServer` instances on port 0, attach `socket.io`, and connect with `socket.io-client` over `ws://127.0.0.1`.
- Tests verify room segregation (`join-preview`, `leave-preview`), payload broadcasting, and disconnect cleanup.

---

## 4. Running the Tests

### 4.1 Backend Test Suite
From the repository root or backend folder:

```bash
cd backend
npm test
```

To run a specific test file:
```bash
cd backend
node --test tests/unit/dockerService.test.js
node --test tests/integration/githubWebhook.test.js
```

### 4.2 Frontend Test Suite
From the repository root or frontend folder:

```bash
# Run all frontend tests once (headless CI mode)
cd frontend
npm test

# Run frontend tests in watch mode during development
cd frontend
npm run test:watch

# Run linter
cd frontend
npm run lint

# Build production bundle
cd frontend
npm run build
```

---

## 5. Continuous Integration (CI)

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on pushes and pull requests targeting the `main` branch across Node.js versions `20.x` and `22.x`.

The CI pipeline consists of 4 jobs:
1. **Frontend**: Clean install (`npm ci`), ESLint checks (`npm run lint`), Vitest test suite (`npm test`), and production bundle build (`npm run build`).
2. **Backend**: Clean install (`npm ci`), Prisma schema validation (`npx prisma validate`), test database migration (`npx prisma db push`), and test execution (`npm test`) against a transient PostgreSQL 16 container.
3. **Docker Templates**: Validates Dockerfile syntax for deployment templates.
4. **CI Status Gatekeeper**: Aggregates all job results into a single required status check for pull request merging.

---

## 6. Maintenance Guidelines

1. **Adding New Backend Services**:
   - Write unit tests under `backend/tests/unit/<serviceName>.test.js`.
   - Prefer injecting external dependencies (such as Docker CLI or Git runners) as default parameters to maintain testability.
   - Always stub `prisma` models using `backend/tests/helpers/prismaMock.js`.

2. **Adding New API Endpoints**:
   - Write integration tests under `backend/tests/integration/<routeName>.test.js` using `supertest(app)`.
   - Use `generateTestToken(user)` and `authHeader(token)` from `backend/tests/helpers/authHelper.js` for authenticated routes.

3. **Adding New Frontend Components & Hooks**:
   - Write component tests under `frontend/src/tests/<ComponentName>.test.jsx`.
   - Mock API interactions with `vi.mock('../api.js')`.
   - Mock SocketContext with `vi.spyOn(socketContext, 'useSocket')`.
