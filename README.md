<div align="center">

# PreviewFlow

### Ephemeral Preview Environments for GitHub Pull Requests

[![CI](https://github.com/AbhijatSinha05/pr-review/actions/workflows/ci.yml/badge.svg)](https://github.com/AbhijatSinha05/pr-review/actions/workflows/ci.yml)
[![Node Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-compatible-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com)
[![License: Custom](https://img.shields.io/badge/license-Custom-blue.svg)](LICENSE.txt)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<p align="center">
  PreviewFlow automatically provisions isolated, containerized preview environments whenever a GitHub Pull Request is opened or updated, streams build logs live to your browser, and cleans up containers upon PR closure.
</p>

[Key Features](#key-features) • [Architecture](#architecture) • [Supported Frameworks](#supported-framework-templates) • [Prerequisites](#prerequisites) • [Quickstart](#quickstart) • [Local PR Simulation](#local-pr-simulation) • [Environment Variables](#environment-variables) • [Tech Stack](#tech-stack) • [Testing](#testing-and-code-quality) • [Contributing](#contributing) • [License](#license)

</div>

---

## Key Features

- **Zero-Config Framework Detection**: Automatically inspects repository dependencies to identify Vite, Next.js, Node.js backends, static HTML, or custom Dockerfiles, mapping the appropriate internal port and build template.
- **Isolated Container Sandboxes**: Deploys preview applications inside resource-capped Docker containers (`--memory 512m`, `--cpus 1.0`, `--pids-limit 100`) enforced with non-root security boundaries (`no-new-privileges`, `cap-drop ALL`).
- **Real-Time Streaming Build Logs**: Streams build stdout and stderr chunk-by-chunk via Socket.IO directly to an in-browser terminal with ANSI syntax coloring.
- **Cryptographic Webhook Verification**: Verifies incoming GitHub `X-Hub-Signature-256` payload signatures using per-project HMAC-SHA256 secrets.
- **Automated Lifecycle Teardown**: Automatically terminates containers, clears temporary checkout directories, and reallocates host ports when a pull request is merged or closed.
- **Local Simulation Engine**: Built-in development endpoint (`/dev/sim-pr`) enables local end-to-end pipeline verification without requiring public tunnels or active GitHub PRs.
- **Tiered Usage Governance**: Multi-tenant subscription tiers (`FREE`, `HOBBY`, `PRO`, `ENTERPRISE`) enforce repository limits and concurrent preview quotas.

---

## Architecture

```
                            GitHub Pull Request
                                     |
                                     v
                     [ GitHub Webhook Event (POST) ]
                                     |
                                     v
                     +------------------------------+
                     | Express API (HMAC-SHA256)    |
                     |  - Verify Signature          |
                     |  - Enforce Tier Quotas       |
                     +--------------+---------------+
                                    |
                                    v
                     +------------------------------+
                     | Repo Cloner (simple-git)     |
                     |  - Fetch PR ref (depth 50)   |
                     |  - Default branch fallback   |
                     +--------------+---------------+
                                    |
                                    v
                     +------------------------------+
                     | Project Type Detector        |
                     |  (Vite / Next / Node / Nginx)|
                     +--------------+---------------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
                  v                                   v
      +----------------------+             +---------------------+
      | Docker Engine        |             | Socket.IO Server    |
      |  - Build Multi-Stage |             |  - Stream chunks to |
      |  - Bind to Localhost |------------>|    room subscribers |
      |  - Start Container   |             +----------+----------+
      +----------+-----------+                        |
                 |                                    |
                 v                                    v
       [ http://localhost:PORT ]            [ React Dashboard ]
        (Live Preview URL)                  (Build Terminal)
```

---

## Supported Framework Templates

Pre-configured, production-hardened Docker templates are located in [`backend/deploy-templates/`](backend/deploy-templates/):

| Framework / Runtime | Detected Markers | Container Port | Multi-Stage Base Images |
| :--- | :--- | :---: | :--- |
| **Vite / React / Vue** | `vite.config.*`, or `react` build script | `80` | `node:18-alpine` -> `nginx:alpine` |
| **Next.js** | `next.config.*`, or `next` dependency | `3000` | `node:18-alpine` (builder) -> `node:18-alpine` (runner) |
| **Node.js Backend** | `package.json` with `start` script | `3000` | `node:18-alpine` |
| **Static HTML / SPA** | `index.html` (no `package.json`) | `80` | `nginx:alpine` |
| **Custom Dockerfile** | `Dockerfile` in root directory | `80` (custom) | User-defined |

---

## Prerequisites

Ensure the following tools are installed before running PreviewFlow:

- [Node.js](https://nodejs.org/) `>= 20.0.0`
- [Docker Engine / Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)
- [PostgreSQL](https://www.postgresql.org/) database
- [Git](https://git-scm.com/)

---

## Quickstart

### 1. Clone the repository

```bash
git clone https://github.com/AbhijatSinha05/pr-review.git
cd pr-review
```

---

### 2. Configure and start the Backend

1. Navigate to the backend directory and install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Create an environment configuration file:
   ```bash
   cp .env.exxample .env
   ```

3. Update `.env` with your credentials:
   ```env
   # PostgreSQL Connection String
   DATABASE_URL="postgresql://postgres:password@localhost:5432/previewflow"

   # GitHub OAuth Application
   GITHUB_CLIENT_ID="your_github_client_id"
   GITHUB_CLIENT_SECRET="your_github_client_secret"

   # Authentication and URLs
   JWT_SECRET="your-secure-random-jwt-secret-at-least-32-chars"
   PUBLIC_WEBHOOK_URL="https://your-public-url.ngrok-free.app"
   PUBLIC_PREVIEW_BASE="http://localhost"
   PORT=4000
   ```

4. Push the Prisma database schema:
   ```bash
   npx prisma db push
   ```

5. Start the backend server:
   ```bash
   npm run dev
   ```
   *Backend runs on `http://localhost:4000`.*

---

### 3. Configure and start the Frontend

1. In a separate terminal, navigate to the frontend directory:
   ```bash
   cd frontend
   npm install
   ```

2. Create the frontend environment configuration:
   ```bash
   cp .env.example .env
   ```
   *(Defaults to `VITE_API_URL=http://localhost:4000`)*

3. Start the Vite development server:
   ```bash
   npm run dev
   ```
   *Frontend interface runs on `http://localhost:5173`.*

---

## Local PR Simulation

You do not need a public IP or webhook proxy (e.g. ngrok) to test PreviewFlow locally. Use the built-in development simulation endpoint to trigger the complete clone, build, run, and log streaming cycle:

```bash
curl -X POST http://localhost:4000/dev/sim-pr \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "<YOUR_PROJECT_ID>",
    "prNumber": 1,
    "action": "open",
    "ref": "main"
  }'
```

### Available Simulation Actions
- `"action": "open"`: Clones repository, builds Docker image, and launches container on an allocated port.
- `"action": "sync"`: Rebuilds the preview environment with the latest commit.
- `"action": "close"`: Terminates the Docker container and releases the port.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Required | Default / Example |
| :--- | :--- | :---: | :--- |
| `DATABASE_URL` | PostgreSQL connection string | **Yes** | `postgresql://user:pass@localhost:5432/db` |
| `JWT_SECRET` | Secret key used to sign and verify user JWTs | **Yes** | `super-secret-jwt-key-min-32-chars` |
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID | **Yes** | `Iv1.xxxxxxxxxxxx` |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret | **Yes** | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `PUBLIC_WEBHOOK_URL` | Public HTTPS URL for GitHub webhook callbacks | **Yes** | `https://api.yourdomain.com` |
| `PUBLIC_PREVIEW_BASE` | Base URL used to construct preview links | No | `http://localhost` |
| `PORT` | Port for the Express and Socket.IO server | No | `4000` |
| `DOCKER_BIN` | Explicit file path to Docker executable | No | Auto-detected |

### Frontend (`frontend/.env`)

| Variable | Description | Required | Default |
| :--- | :--- | :---: | :--- |
| `VITE_API_URL` | Base URL of the backend API | **Yes** | `http://localhost:4000` |

---

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React 19, Vite, Tailwind CSS, Lucide Icons, Framer Motion, Socket.IO Client, Axios |
| **Backend** | Node.js (ESM), Express 5, Prisma ORM, Socket.IO, Dockerode, simple-git |
| **Database** | PostgreSQL (relational schema with cascade rules and composite indexes) |
| **Sandboxing** | Docker Engine (multi-stage builds, non-root execution, cgroups limits) |
| **CI / Automation** | GitHub Actions (Matrix validation across Node 20.x and 22.x, Docker syntax checks) |

---

## Testing and Code Quality

Run tests and validation locally across both applications:

```bash
# Backend test suite (unit, integration, and security checks)
cd backend
npm test

# Frontend static analysis and linting
cd frontend
npm run lint

# Frontend production bundle verification
npm run build
```

---

## Contributing

To contribute to PreviewFlow:

1. Fork the repository.
2. Create a dedicated branch for your change:
   ```bash
   git checkout -b feat/custom-dockerfile-caching
   ```
3. Commit your changes following the [Conventional Commits](https://www.conventionalcommits.org/) convention:
   ```bash
   git commit -m "feat(docker): add build cache layer support"
   ```
4. Push to your fork:
   ```bash
   git push origin feat/custom-dockerfile-caching
   ```
5. Submit a Pull Request targeting the `main` branch. Ensure all automated CI checks pass.

---

## License

This project is licensed under a **custom non-commercial license**. Refer to [`LICENSE.txt`](LICENSE.txt) for complete terms.

- **Non-Commercial Use**: Free for personal, hobby, educational, research, or internal non-commercial use.
- **Commercial Use**: Any commercial or revenue-generating deployment requires prior written authorization.
- **Attribution**: Any public or production deployment must include attribution:  
  *"This project includes software created by Abhijat Sinha."*

---

<div align="center">
  <sub>Maintained by <a href="https://github.com/AbhijatSinha05">Abhijat Sinha</a></sub>
</div>
