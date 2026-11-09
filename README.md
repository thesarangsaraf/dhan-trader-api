# ⚡ Dhan Trader — NestJS (TypeScript) Pure Backend Trading Engine & Alert Service

A high-performance, enterprise-grade backend algorithmic trading engine and price alert microservice built on **NestJS** and **TypeScript** with the **Dhan HQ API v2**. Features full architectural TypeScript decorators (`@Controller`, `@Injectable`, `@Module`, `@Body`, `@Query`, `@Param`), interactive **Swagger UI documentation (`/docs`)**, native support for NSE Indices alerts, live order and position management, and live Telegram alert dispatch.

---

## 🌟 Key Architecture & Capabilities

- **100% TypeScript (`.ts`) & NestJS Framework**:
  - Modular enterprise architecture organized into feature modules (`AuthModule`, `AlertsModule`, `OrdersModule`, `InstrumentsModule`, `TelegramModule`, `ConfigModule`, `DhanModule`).
  - Standard NestJS decorators for dependency injection, controllers, request parsing, and validation pipes.
  - Zero plain JavaScript (`.js`) files in application code, scripts, or test suites.
- **DTO Validation & Schema Transformation**:
  - Request payloads validated via `class-validator` and `class-transformer` (`PlaceOrderDto`, `CreateAlertDto`, `UpdateAlertDto`, `UpdateTokenDto`, `UpdateTelegramDto`).
  - Global `ValidationPipe` active across all routes.
- **Interactive Swagger Documentation**:
  - Built-in interactive Swagger UI at `http://127.0.0.1:8000/docs` (and `/swagger`).
  - Raw OpenAPI 3.0 specification at `http://127.0.0.1:8000/api/docs/openapi.json` for frontend SDK and client generation.
- **Pure Headless Backend**:
  - Zero UI or static HTML/frontend dependencies.
  - Easily consumes or integrates with custom React, Vue, Next.js dashboards, mobile apps, or headless trading bots.
- **Index & F&O Alert Monitoring**:
  - Monitors and triggers price alerts on benchmark NSE indices and F&O instruments using tick monitoring.
- **Telegram Bot Notifications**:
  - Automated dispatches for triggered alerts and orders (placed, executed, cancelled).
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

### 6. Verify Google Cloud Firestore & Seed Scrip Masters
```bash
# Test Firestore connectivity & token sync
npm run check:firestore

# Upload/seed NSE index options master into Firestore database
npm run upload:index-options

# Upload/sync modular sec_id_to_name_mapping (divided by instrument)
npm run upload:sec-id-mapping
```

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
Returns pre-populated benchmark indices (NIFTY 50, BANK NIFTY, SENSEX, MIDCAP NIFTY).

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

### 4. Orders & Positions (`/api/orders`, `/api/positions`)

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

---

### 5. Instruments & Lot Sizes Management (`/api/instruments`)

#### `GET /api/instruments?q=NIFTY&limit=10`
Searches pre-loaded NSE indices, F&O option contracts, and top equities with live LTP.

#### `GET /api/instruments/lot-sizes`
Returns database-driven lot size configuration for NSE indices (NIFTY 50, BANK NIFTY, FINNIFTY, MIDCAP NIFTY, SENSEX) backed by Google Cloud Firestore.

#### `PUT /api/instruments/lot-sizes`
Updates and persists index lot sizes in Firestore collection `config/lot_sizes`.
```bash
curl -X PUT http://127.0.0.1:8000/api/instruments/lot-sizes \
  -H "Content-Type: application/json" \
  -d '{"nifty50": 65, "bankNifty": 30, "finNifty": 65, "midcapNifty": 120, "sensex": 20}'
```

#### `POST /api/instruments/lot-sizes/reset`
Restores index lot sizes to standard NSE defaults.

#### `GET /api/instruments/indices`
Returns the tradeable indices configured in Firestore (`config/lot_sizes`), including exchange segment, lot size, default lots/quantity, and live LTP, used by the UI Alert Composer dropdown.

#### `POST /api/instruments/sync`
Synchronizes NSE security master & option contracts directly into Google Cloud Firestore (`sec_id_to_name_mapping`).

#### `GET /api/instruments/sync/status`
Returns metadata and document structure for the Firestore security master collection.

---

### 6. Telegram Notifications (`/api/telegram`)

#### `GET /api/telegram/status`
Returns Telegram bot configuration and connection status.

#### `POST /api/telegram/test`
Sends a test verification ping to the configured Telegram chat.

#### `POST /api/telegram/update`
Updates `botToken` and `chatId` dynamically.

---

## 🐳 Docker & GCP Cloud Run Deployment

The repository includes an optimized multi-stage [Dockerfile](file:///Users/sarangsaraf/git/dhan-trader-api/Dockerfile) tailored for **GCP Cloud Run** and serverless container runtimes. The production runtime is built on `node:22-alpine`, executes as an unprivileged user (`node`), includes `dumb-init` for graceful `SIGTERM` process supervision, and achieves a compressed download size of ~**55–65 MB** in Google Artifact Registry (~**180 MB** uncompressed).

### 1. Authenticate Docker with GCP Artifact Registry

Google Artifact Registry for this project is located in **`asia-south1` (Mumbai)** under repository **`dhan-api-docker`**:
```text
asia-south1-docker.pkg.dev/dhan-trader-514002/dhan-api-docker/dhan-trader-api:latest
```

Choose either authentication method:

#### Option A: Using `gcloud` CLI (Standard)
```bash
gcloud auth configure-docker asia-south1-docker.pkg.dev
```

#### Option B: Using Service Account Key (No `gcloud` CLI required)
```bash
cat google-service-account-key.json | docker login -u _json_key --password-stdin https://asia-south1-docker.pkg.dev
```

---

### 2. Set Image URL & Build Image for Cloud Run

> [!IMPORTANT]
> When building on macOS (Apple Silicon M-series), always pass `--platform linux/amd64` to ensure the container runs natively on Cloud Run's x86_64 architecture without architecture mismatch errors.

```bash
# 1. Export production image tag
export IMAGE_TAG="asia-south1-docker.pkg.dev/dhan-trader-514002/dhan-api-docker/dhan-trader-api:latest"

# 2. Build multi-stage production Docker image
docker build --platform linux/amd64 -t $IMAGE_TAG .
```

---

### 3. Push Image to GCP Artifact Registry

```bash
docker push $IMAGE_TAG
```

---

### 4. Deploy to GCP Cloud Run

#### Option A: Via Google Cloud Console (Web UI)
1. Go to **Google Cloud Console** → **Artifact Registry**.
2. Click repository **`dhan-api-docker`** (Region: `asia-south1`) → click **`dhan-trader-api`** → select tag **`latest`**.
3. Click **Deploy to Cloud Run**.
4. Configure service settings:
   - **Region**: `asia-south1 (Mumbai)`.
   - **Authentication**: Allow unauthenticated invocations (or require IAM as preferred).
   - **Container Port**: `8080`.
   - **Environment Variables**: Cloud Run automatically supplies `PORT=8080`. Add `FIRESTORE_PROJECT_ID=dhan-trader-514002` and `FIRESTORE_DATABASE_ID=dhan-trader-firebase-db`.

#### Option B: Via `gcloud` CLI
```bash
gcloud run deploy dhan-trader-api \
  --image $IMAGE_TAG \
  --platform managed \
  --region asia-south1 \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars "FIRESTORE_PROJECT_ID=dhan-trader-514002,FIRESTORE_DATABASE_ID=dhan-trader-firebase-db"
```

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
│   │   ├── orders.controller.ts       # Orders and positions REST controller
│   │   ├── orders.module.ts           # Orders feature module
│   │   ├── orders.service.ts          # Order execution service
│   │   └── dto/
│   │       └── place-order.dto.ts     # Manual order placement DTO
│   └── telegram/
│       ├── telegram.controller.ts     # Telegram status & test REST controller
│       ├── telegram.module.ts         # Telegram feature module
│       ├── telegram.service.ts        # Telegram bot HTML message dispatcher
│       └── dto/
│           └── update-telegram.dto.ts # DTO for Telegram config updates
├── tests/
│   ├── alerts.service.spec.ts         # TypeScript unit tests for AlertsService
│   ├── app.e2e-spec.ts                # TypeScript E2E integration tests for all REST routes
│   ├── auth.service.spec.ts           # TypeScript unit tests for AuthService & JWT decoding
│   └── orders.service.spec.ts         # TypeScript unit tests for OrdersService
├── .env                               # Environment credentials
├── .dockerignore                      # Build context exclusions
├── Dockerfile                         # Production multi-stage Docker build (Cloud Run)
├── package.json                       # Scripts, NestJS & TypeScript dependencies
├── tsconfig.json                      # TypeScript compiler configuration
└── README.md                          # NestJS architecture & API documentation
```

---

## 🔒 Security & Strict Zero Static Fallback Policy

1. **No Static Fallback Credentials or Data**:
   - The backend and UI code contain **zero hardcoded fallback passwords, static security PINs, mock instruments, or synthetic option contracts**.
   - All credentials and configurations (including the trade authorization password) are fetched strictly and dynamically from Google Cloud Firestore (`config/security`).
   - If required security configurations or data are unavailable, the system explicitly rejects the request with an error. No static fallbacks (e.g. `password.trim() === '3646'`) are allowed in source code.

2. **Zero Secret Exposure on UI / Docs**:
   - Passwords, tokens, and PINs are never exposed in UI placeholder text, helper labels, error toasts, or Swagger documentation examples.

---

## 🛡️ License
MIT
