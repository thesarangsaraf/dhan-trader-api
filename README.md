# ⚡ Dhan Trader — NestJS (TypeScript) Pure Backend Trading Engine & Alert Service

A high-performance, enterprise-grade backend algorithmic trading engine and price alert microservice built on **NestJS** and **TypeScript** with the **Dhan HQ API v2**. Features full architectural TypeScript decorators (`@Controller`, `@Injectable`, `@Module`, `@Body`, `@Query`, `@Param`), interactive **Swagger UI documentation (`/docs`)**, native support for NSE Indices alerts without requiring a static IP, automated bracket order execution (Auto-SL / Target), and live Telegram alert dispatch.

---

## 🌟 Key Architecture & Capabilities

- **100% TypeScript (`.ts`) & NestJS Framework**:
  - Modular enterprise architecture organized into feature modules (`AuthModule`, `AlertsModule`, `OrdersModule`, `InstrumentsModule`, `TelegramModule`, `ConfigModule`, `DhanModule`).
  - Standard NestJS decorators for dependency injection, controllers, request parsing, and validation pipes.
  - Zero plain JavaScript (`.js`) files in application code, scripts, or test suites.
- **DTO Validation & Schema Transformation**:
  - Request payloads validated via `class-validator` and `class-transformer` (`PlaceOrderDto`, `AutoSlDto`, `CreateAlertDto`, `UpdateAlertDto`, `UpdateTokenDto`, `UpdateTelegramDto`).
  - Global `ValidationPipe` active across all routes.
- **Interactive Swagger Documentation**:
  - Built-in interactive Swagger UI at `http://127.0.0.1:8000/docs` (and `/swagger`).
  - Raw OpenAPI 3.0 specification at `http://127.0.0.1:8000/api/docs/openapi.json` for frontend SDK and client generation.
- **Pure Headless Backend**:
  - Zero UI or static HTML/frontend dependencies.
  - Easily consumes or integrates with custom React, Vue, Next.js dashboards, mobile apps, or headless trading bots.
- **Zero Static IP Barrier**:
  - Monitors and triggers price alerts on benchmark NSE indices and F&O instruments using tick monitoring without requiring static IP allocation.
- **Auto-SL (-7 pts) & Target (+30 pts) Strategy Runner**:
  - Automated bracket execution for Nifty FNO Long positions.
  - Automatically calculates Stop-Loss at `Entry - 7 pts` and Target at `Entry + 30 pts` (Risk:Reward ratio 1:4.29).
  - Emits real-time execution step logs and dispatches immediate Telegram messages.
- **Telegram Bot Notifications**:
  - Automated dispatches for triggered alerts, orders (placed, executed, cancelled), and bracket strategy executions.
- **Dhan Token Expiry & Refresh Service**:
  - Inspects JWT `exp` and `iat` claims, outputting human-readable Indian Standard Time (IST) expiration stamps and countdowns.
  - Live API validation pinging `https://api.dhan.co/v2/profile`.
  - In-place token updates via API (`/api/auth/update` and `/api/auth/renew`) persisted directly to `.env` with hot-reloading.

---

## 🚀 Quick Start

### 1. Configure Environment
Verify `.env` has your Dhan and Telegram credentials:
```env
DHAN_CLIENT_ID='your_client_id'
DHAN_ACCESS_TOKEN='your_jwt_access_token'
TELEGRAM_BOT_TOKEN='your_telegram_bot_token'
TELEGRAM_CHAT_ID='your_telegram_chat_id'
PORT=8000
HOST='127.0.0.1'
POLL_INTERVAL_MS=4000
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Build & Run NestJS Service

#### Development Mode (Hot Reload with `ts-node`):
```bash
npm run start:dev
```

#### Production Build & Run:
```bash
npm run build
npm start
```

The service will output:
```
====================================================
🚀 Dhan Trader Backend API active on http://127.0.0.1:8000
🛠️ Framework: NestJS (TypeScript)
⚡ Static IP: Not required for Alerts & Trading
📖 Swagger API Docs: http://127.0.0.1:8000/docs
📄 OpenAPI Spec: http://127.0.0.1:8000/api/docs/openapi.json
====================================================
```

### 4. Run Test Suite
```bash
npm test
```
All unit and e2e integration tests run in TypeScript using Node.js's native test runner with `ts-node` transpile registration.

### 5. Verify Live Dhan Connection
```bash
npm run check:dhan
```
Tests live connection to Dhan HQ API v2 for profile, margin fund limits, demat holdings, and active positions.

---

## 📡 REST API Reference

### 1. Service Health & API Root
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` or `/health` or `/api` | Service status, timestamp, and index of all available endpoints |

**Sample Response (`GET /`):**
```json
{
  "name": "Dhan Trader Backend API",
  "framework": "NestJS",
  "status": "ONLINE",
  "version": "2.0.0",
  "service": "Pure Backend Trading Engine & Price Alert Bot (TypeScript)",
  "timestamp": "2026-11-05T12:00:00.000Z",
  "dhanStatus": {
    "clientId": "1106885516",
    "staticIpRequired": false
  },
  "documentation": {
    "swaggerUi": "/docs",
    "openApiSpec": "/api/docs/openapi.json"
  },
  "endpoints": { ... }
}
```

---

### 2. Authentication & Token Management (`/api/auth`)

#### `GET /api/auth/status`
Decodes the configured access token and returns expiration timestamps in IST.
```bash
curl http://127.0.0.1:8000/api/auth/status
```

#### `GET /api/auth/verify`
Tests token validity directly against the Dhan API (`/profile`).
```bash
curl http://127.0.0.1:8000/api/auth/verify
```

#### `POST /api/auth/renew`
Renews the token via Dhan API `/RenewToken` and persists it to `.env`.
```bash
curl -X POST http://127.0.0.1:8000/api/auth/renew
```

#### `POST /api/auth/update`
Hot-reloads a new token and updates `.env` without restart.
```bash
curl -X POST http://127.0.0.1:8000/api/auth/update \
  -H "Content-Type: application/json" \
  -d '{"token": "NEW_JWT_TOKEN", "clientId": "1106885516"}'
```

---

### 3. Price Alerts Service (`/api/alerts`)
Alerts run in-memory and persist across restarts in `data/alerts.json`.

#### `GET /api/alerts`
Returns all registered price alerts.

#### `GET /api/alerts/grouped`
Returns alerts grouped by instrument with active and triggered counts.

#### `GET /api/alerts/indices`
Returns pre-populated NSE benchmark indices (NIFTY 50, NIFTY BANK, FIN NIFTY, MIDCP NIFTY, INDIA VIX, etc.).

#### `POST /api/alerts`
Creates a new price alert.
```bash
curl -X POST http://127.0.0.1:8000/api/alerts \
  -H "Content-Type: application/json" \
  -d '{
    "instrument": "NIFTY 50",
    "targetPrice": 24900.0,
    "operator": "GREATER_THAN_OR_EQUAL",
    "remarks": "Breakout above 24900"
  }'
```

#### `POST /api/alerts/:id/cancel`
Cancels an active alert.

#### `PUT /api/alerts/:id`
Updates an existing alert.

#### `DELETE /api/alerts/:id`
Deletes an alert permanently.

---

### 4. Orders, Positions & Strategy (`/api/orders`, `/api/positions`, `/api/strategy`)

#### `GET /api/orders`
Fetches all live orders directly from the Dhan API.

#### `POST /api/orders`
Places a new order on Dhan HQ API v2.
```bash
curl -X POST http://127.0.0.1:8000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "NIFTY 24500 CE",
    "securityId": "45021",
    "exchangeSegment": "NSE_FNO",
    "transactionType": "BUY",
    "orderType": "MARKET",
    "productType": "INTRADAY",
    "quantity": 50,
    "price": 130.0
  }'
```

#### `DELETE /api/orders/:id`
Cancels an order on Dhan by ID.

#### `GET /api/positions`
Returns current positions, funds/margins, and net P&L summary from Dhan API.

#### `GET /api/holdings`
Returns Dhan Demat equity portfolio holdings.

#### `POST /api/strategy/auto-sl`
Executes an automated bracket strategy: Long entry + Stop-Loss (-7 pts) + Target (+30 pts).
```bash
curl -X POST http://127.0.0.1:8000/api/strategy/auto-sl \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "NIFTY 24600 CE",
    "entryPrice": 140.0,
    "quantity": 50
  }'
```

---

### 5. Instruments Lookup (`/api/instruments`)

#### `GET /api/instruments?q=NIFTY&limit=10`
Searches pre-loaded NSE indices, F&O option contracts, and top equities.

---

### 6. Telegram Notifications (`/api/telegram`)

#### `GET /api/telegram/status`
Returns Telegram bot configuration and connection status.

#### `POST /api/telegram/test`
Sends a test verification ping to the configured Telegram chat.

#### `POST /api/telegram/update`
Updates `botToken` and `chatId` dynamically.

---

## 📂 Project Structure

```
dhan-trader/
├── data/
│   └── alerts.json                    # Persistent alert store
├── dist/                              # Compiled JavaScript output (from tsc)
├── scripts/
│   └── verify-dhan.ts                 # Dhan HQ live connectivity test script (TypeScript)
├── src/
│   ├── app.controller.ts              # Root controller (/, /health, /api)
│   ├── app.module.ts                  # NestJS root application module
│   ├── main.ts                        # Bootstrap, Swagger setup & global validation pipes
│   ├── alerts/
│   │   ├── alerts.controller.ts       # Alerts REST controller (@Controller('api/alerts'))
│   │   ├── alerts.module.ts           # Alerts feature module
│   │   ├── alerts.service.ts          # Tick monitor & alert engine (@Injectable)
│   │   └── dto/
│   │       ├── create-alert.dto.ts    # DTO with class-validator decorators
│   │       └── update-alert.dto.ts    # DTO for partial alert updates
│   ├── auth/
│   │   ├── auth.controller.ts         # Token inspection & refresh REST controller
│   │   ├── auth.module.ts             # Auth feature module
│   │   ├── auth.service.ts            # JWT expiry decoder & renewal engine
│   │   └── dto/
│   │       └── update-token.dto.ts    # DTO for token hot-reload
│   ├── config/
│   │   ├── config.module.ts           # Global configuration module (@Global())
│   │   └── config.service.ts          # Environment variables & .env watcher
│   ├── dhan/
│   │   ├── dhan.module.ts             # Dhan HQ API client module (@Global())
│   │   └── dhan.service.ts            # Dhan HQ API v2 client service
│   ├── instruments/
│   │   ├── instruments.controller.ts  # Security lookup REST controller
│   │   ├── instruments.module.ts      # Instruments feature module
│   │   └── instruments.service.ts     # Scrip master & search service
│   ├── orders/
│   │   ├── orders.controller.ts       # Orders, positions & strategy REST controller
│   │   ├── orders.module.ts           # Orders feature module
│   │   ├── orders.service.ts          # Order execution & Auto-SL bracket runner
│   │   └── dto/
│   │       ├── auto-sl.dto.ts         # Auto-SL bracket runner DTO
│   │       └── place-order.dto.ts     # Manual order placement DTO
│   └── telegram/
│       ├── telegram.controller.ts    # Telegram status & test REST controller
│       ├── telegram.module.ts         # Telegram feature module
│       ├── telegram.service.ts        # Telegram bot HTML message dispatcher
│       └── dto/
│           └── update-telegram.dto.ts # DTO for Telegram config updates
├── tests/
│   ├── alerts.service.spec.ts         # TypeScript unit tests for AlertsService
│   ├── app.e2e-spec.ts                # TypeScript E2E integration tests for all REST routes
│   ├── auth.service.spec.ts           # TypeScript unit tests for AuthService & JWT decoding
│   └── orders.service.spec.ts         # TypeScript unit tests for OrdersService & Auto-SL
├── .env                               # Environment credentials
├── package.json                       # Scripts, NestJS & TypeScript dependencies
├── tsconfig.json                      # TypeScript compiler configuration
└── README.md                          # NestJS architecture & API documentation
```

---

## 🛡️ License
MIT
