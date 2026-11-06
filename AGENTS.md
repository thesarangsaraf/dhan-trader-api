# 🤖 AGENTS.md — Dhan Trader Development & Operational Guidelines

This document provides definitive instructions, architecture patterns, constraints, and operational guidelines for AI coding agents and autonomous developer tools working within the **Dhan Trader** repository.

---

## 🎯 Repository Overview & Purpose

**Dhan Trader** is a pure, headless backend microservice and algorithmic trading engine built with **NestJS** and **TypeScript**, integrated with the **Dhan HQ API v2**.
- **Role**: Manage orders and positions, provide real-time price alert monitoring on NSE indices without static IP restrictions, decode/renew JWT authentication tokens, and dispatch live notifications to Telegram.
- **Form Factor**: 100% headless REST API backend. It contains zero UI, HTML, or static frontend bundles. Clients consume this service via REST or generated OpenAPI SDKs.

---

## 🛡️ Critical Non-Negotiable Directives

1. **Strict TypeScript (`.ts`) Only**:
   - All source code in `src/`, scripts in `scripts/`, and test suites in `tests/` MUST be written in `.ts`.
   - **NO plain JavaScript (`.js`) files** may be authored or committed to the codebase.
   - Production JavaScript is generated strictly to `dist/` via `npm run build` (`tsc`).

2. **NestJS Architectural Compliance**:
   - Adhere strictly to the NestJS modular architecture:
     - Feature grouping into modules (`@Module({ ... })`).
     - Dependency injection via `@Injectable()`.
     - Route routing via `@Controller()` with standard parameter decorators (`@Body()`, `@Query()`, `@Param()`, `@Headers()`).
     - Explicit HTTP response codes using `@HttpCode(...)` when deviating from NestJS defaults.

3. **DTOs & Strong Validation**:
   - Every input payload must be typed as a Data Transfer Object (DTO) in a dedicated `dto/` directory.
   - DTOs must use `class-validator` decorators (`@IsString()`, `@IsNumber()`, `@IsOptional()`, `@IsEnum()`, etc.) and `class-transformer` (`@Type(() => Number)`).
   - The global `ValidationPipe` is enabled in `src/main.ts` with `{ transform: true, whitelist: false }`.

4. **Swagger & OpenAPI Maintenance**:
   - All controllers and route handlers must be decorated with `@nestjs/swagger` decorators (`@ApiTags()`, `@ApiOperation()`, `@ApiResponse()`, `@ApiParam()`, `@ApiQuery()`).
   - All DTO properties must be decorated with `@ApiProperty()` or `@ApiPropertyOptional()`.
   - Interactive Swagger is served at `/docs` (and `/swagger`).
   - Raw OpenAPI 3.0 specification is served at `GET /api/docs/openapi.json`.

5. **Pure Headless Backend**:
   - Do not add static frontends, HTML views, or frontend build pipelines (Webpack/Vite for React/Vue) to this repository.
   - Any UI needs are served by external frontend applications consuming `/api/docs/openapi.json`.

6. **Cross-Repository UI Coordination (`dhan-trader-ui`)**:
   - If there is a change in any backend API or any functionality that can affect the UI, the frontend UI project is available in the folder `dhan-trader-ui` under the same directory (`../dhan-trader-ui`).
   - Go there, check the frontend codebase, and make changes if needed (e.g. updating API models, service methods, endpoints, or UI components).
   - Always ensure both projects remain in sync, pass their test suites (`npm test`), and compile production builds (`npm run build`) without errors.

---

## 📂 Architecture & Directory Structure

```
dhan-trader/
├── .env                               # Active secrets & configuration (Git-ignored)
├── .env.example                       # Template configuration for onboarding
├── package.json                       # Scripts & dependencies
├── tsconfig.json                      # TypeScript configuration (ES2022, CommonJS, Decorators)
├── README.md                          # Human-facing documentation
├── AGENTS.md                          # Agent-facing operational guidelines (this file)
├── dist/                              # Output directory for tsc compiler
├── scripts/
│   └── verify-dhan.ts                 # Real live Dhan HQ API connectivity script
├── src/
│   ├── main.ts                        # Application entry point, Swagger init, ValidationPipe
│   ├── app.module.ts                  # Root NestJS module registering all feature modules
│   ├── app.controller.ts              # Root metadata and health check endpoints
│   ├── config/
│   │   ├── config.module.ts           # @Global() configuration module
│   │   └── config.service.ts          # Config loader with fs.watchFile hot-reloader
│   ├── dhan/
│   │   ├── dhan.module.ts             # @Global() Dhan API client provider
│   │   └── dhan.service.ts            # Dhan HQ API v2 HTTPS client wrapper
│   ├── auth/
│   │   ├── auth.module.ts             # Authentication feature module
│   │   ├── auth.controller.ts         # /api/auth endpoints (status, verify, renew, update)
│   │   ├── auth.service.ts            # JWT decoding, IST timestamp math, token renewal
│   │   └── dto/update-token.dto.ts    # DTO for token updates
│   ├── alerts/
│   │   ├── alerts.module.ts           # Price alerts feature module
│   │   ├── alerts.controller.ts       # /api/alerts endpoints (CRUD, indices, polling)
│   │   ├── alerts.service.ts          # Tick evaluator & alerts engine
│   │   └── dto/
│   │       ├── create-alert.dto.ts    # DTO for alert creation
│   │       └── update-alert.dto.ts    # DTO for partial alert updates
│   ├── orders/
│   │   ├── orders.module.ts           # Orders feature module
│   │   ├── orders.controller.ts       # /api/orders, /api/positions
│   │   ├── orders.service.ts          # Live order dispatcher and positions service
│   │   └── dto/
│   │       └── place-order.dto.ts     # DTO for manual orders
│   ├── instruments/
│   │   ├── instruments.module.ts      # Scrip search module
│   │   ├── instruments.controller.ts  # /api/instruments search endpoint
│   │   └── instruments.service.ts     # NSE security master cache and search index
│   └── telegram/
│       ├── telegram.module.ts         # Telegram integration module
│       ├── telegram.controller.ts     # /api/telegram status and ping test endpoints
│       ├── telegram.service.ts        # Telegram bot HTML message dispatcher
│       └── dto/update-telegram.dto.ts # DTO for Telegram bot settings update
└── tests/
    ├── alerts.service.spec.ts         # Unit tests for AlertsService
    ├── orders.service.spec.ts         # Unit tests for OrdersService
    ├── auth.service.spec.ts           # Unit tests for AuthService & JWT calculations
    └── app.e2e-spec.ts                # E2E integration tests for all REST endpoints
```

---

## 🛠️ CLI & Operational Commands

Always use the following npm scripts rather than manual invocation:

| Command | Action |
|---|---|
| `npm run start:dev` | Launch development server with hot-reload via `ts-node` |
| `npm run build` | Compile TypeScript into `dist/` via `tsc` |
| `npm start` | Run compiled production server from `dist/main.js` |
| `npm test` | Run all TypeScript unit and E2E specs via `ts-node/register/transpile-only` |
| `npm run check:dhan` | Execute live API verification against Dhan HQ v2 |

---

## 🧪 Testing Guidelines for Agents

- **Runner**: Node.js native test runner (`node --test`) paired with `ts-node/register/transpile-only`.
- **Sandbox Safety & No Live Market Orders in Tests**:
  - Unit tests and E2E route tests MUST stub or mock `dhanService` and `telegramService`.
  - **Never** allow automated test runs to place real market orders with real money against the live Dhan account.
  - Tests that do not mock external network calls risk hanging or failing due to sandbox network isolation or rate-limiting.
- **Port Binding in Tests**:
  - In `app.e2e-spec.ts`, avoid binding ephemeral loopback TCP sockets (which may fail in sandboxed Windows environments). Instead, test using in-memory request simulation via `app.getHttpAdapter().getInstance()` and synthetic `http.IncomingMessage` / `http.ServerResponse` mocks.

---

## 🔌 Dhan HQ API v2 Peculiarities & Nuances

When interacting with or extending `src/dhan/dhan.service.ts`, keep these behaviors in mind:

1. **Authentication Headers**:
   - `access-token`: Passed as a raw JWT string header.
   - `client-id`: Passed as a string header matching the user's Dhan Client ID (e.g., `1106885516`).

2. **Data APIs / Marketfeed**:
   - Free or standard Dhan accounts may have the Data API inactive (`401 Data APIs not Subscribed`).
   - Alerts and order dispatchers must not crash if live websocket or marketfeed data is unavailable; fallback pricing or index cache must be supported.

3. **Token Hot-Reloading**:
   - The Dhan JWT access token expires after 24 hours.
   - `ConfigService` monitors `.env` with `fs.watchFile`. When an agent or user calls `POST /api/auth/update` or `POST /api/auth/renew`, the service writes new credentials to `.env`, which immediately reloads in memory without restarting the process.

---

## 🪟 Windows Environment & Process Management

1. **Port 8000 Conflicts**:
   - If starting the server fails with `EADDRINUSE: address already in use :::8000`:
     ```powershell
     # Find owning PID:
     Get-NetTCPConnection -LocalPort 8000 -State Listen | Select-Object OwningProcess
     # Terminate the orphan process:
     Stop-Process -Id <PID> -Force
     ```

2. **Execution Timing**:
   - When launching long-running processes (like the server daemon), use `IsDaemon: true` with a sufficient `WaitMsBeforeAsync` (~5000ms).

---

## 💡 Summary Checklist for Agent Code Changes

Before marking any task as complete:
- [ ] No `.js` files were introduced in `src/`, `scripts/`, or `tests/`.
- [ ] TypeScript compiles cleanly with zero errors (`npx tsc --noEmit` or `npm run build`).
- [ ] All tests pass cleanly (`npm test`).
- [ ] Every new endpoint is registered with appropriate `@ApiTags`, `@ApiOperation`, and `@ApiResponse` decorators.
- [ ] Input payloads have corresponding DTO classes with `class-validator` rules.
- [ ] If any backend API or UI-affecting functionality was modified, checked `../dhan-trader-ui` and made necessary changes there.
- [ ] Code comments and existing docstrings remain intact.
