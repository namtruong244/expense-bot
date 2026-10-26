# Expense Bot 💳 🤖

> A modern, serverless personal finance assistant built on **Cloudflare Workers** and **Cloudflare D1**, powered by **Google Gemini AI** for natural language understanding and receipt image OCR. Supports both **Telegram Bot** and **Apple Shortcuts** (iOS/macOS).

---

## ✨ Features

- **🧠 AI-Powered Transaction Parsing**: Uses Google Gemini (`gemini-3.1-flash` with automatic fallback to `gemini-2.5-flash`) to parse both free-form text and receipt photos into structured financial data.
- **💳 Credit Card Debt Management**:
  - Automatically identifies credit card purchases from text or receipts.
  - Tracks unpaid credit card bills (`/debt`).
  - Allows settling individual bills, multiple bills, or all debts at once (`/pay`).
- **🔄 Expense & Refund Tracking**: Distinguishes between normal expenses (🔴) and refunds/order cancellations (🟢), automatically calculating net totals.
- **📊 Timezone-Aware Reporting**: Converts UTC timestamps to local calendar time (UTC+7) for accurate daily (`/today`) and monthly category breakdowns (`/month`).
- **📱 Apple Shortcuts Integration**: Direct webhook endpoint (`source: "shortcut"`) allowing 1-tap expense logging via iPhone Action Button, Siri, or Share Sheet with instant notifications.
- **⚡ Serverless & Global**: Runs on Cloudflare's global edge network with sub-second execution and Cloudflare D1 distributed SQLite storage.
- **🛡️ 100% Type-Safe & Clean Architecture**: Strict TypeScript without `any` types, modular structure (services, handlers, formatters), and 73+ comprehensive unit tests with Vitest.

---

## 🤖 Telegram Bot Commands

| Command | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `/start`, `/help` | `/trogiup` | Display the interactive help menu and available commands | `/help` |
| `/today` | `/homnay` | View today's transactions, category breakdowns, and net total | `/today` |
| `/month` | `/thismonth`, `/thangnay` | Monthly expense report grouped by category with net spending | `/month` |
| `/debt` | `/credit`, `/nothe` | List all unpaid credit card bills and total outstanding debt | `/debt` |
| `/pay <id\|ids\|all>` | `/trano`, `/paydebt` | Mark specific or all credit card bills as settled/paid | `/pay 5`<br>`/pay 5, 8`<br>`/pay all` |
| `/model` | `/gemini` | View active Gemini model, switch models, or auto-sync from Google API | `/model`<br>`/model auto`<br>`/model gemini-3.5-flash`<br>`/model reset` |
| `/delete` | `/xoa` | Undo / delete the most recent recorded transaction | `/delete` |

### Natural Language Examples

You can record transactions simply by messaging the bot:

- **Regular Expense**: `Lunch 50k` or `Coffee $3.5`
- **Receipt Photo**: Take a photo of an invoice or receipt and send it to the bot (optional caption)
- **Credit Card Purchase**: `Zara jacket 450k credit card` or `Dinner 250k quẹt thẻ`
- **Refund / Cancellation**: `Shopee refund 120k` or `Flight cancellation refund $200`

---

## 🏗️ Architecture & Project Structure

```text
expense-bot/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions CI/CD pipeline
├── src/
│   ├── constants.ts            # System prompts, Gemini models, schema & defaults
│   ├── formatters.ts           # Shared currency and number formatting helpers
│   ├── types.ts                # TypeScript domain models and interfaces
│   ├── handlers/
│   │   ├── commands.ts         # Telegram slash command handlers (/today, /debt, /pay...)
│   │   ├── shortcut.ts         # Apple Shortcuts webhook handler
│   │   └── telegram.ts         # Telegram webhook message & photo handler
│   ├── services/
│   │   ├── db.ts               # Cloudflare D1 database operations & queries
│   │   ├── gemini.ts           # Google Gemini API client with multi-model fallback
│   │   └── telegram.ts         # Telegram Bot API client & CDN photo downloader
│   └── index.ts                # Cloudflare Worker fetch entry point & routing
├── test/
│   ├── index.spec.ts           # Comprehensive Vitest unit test suite (73 tests)
│   └── tsconfig.json           # Test TypeScript configuration
├── schema.sql                  # SQLite table definitions and indexes for D1
├── wrangler.jsonc              # Cloudflare Wrangler worker configuration
├── vitest.config.mts           # Vitest test configuration
└── package.json
```

---

## 🚀 Getting Started

### 1. Prerequisites

- **Node.js** (v20 or higher recommended, Node.js 24 supported)
- **npm** or package manager of choice
- A **Cloudflare Account**
- A **Telegram Bot Token** (created via [@BotFather](https://t.me/BotFather))
- A **Google Gemini API Key** (obtained via [Google AI Studio](https://aistudio.google.com/))

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/namtruong244/expense-bot.git
cd expense-bot
npm install
```

### 3. Initialize Cloudflare D1 Database

Create a D1 database named `expense-db`:

```bash
npx wrangler d1 create expense-db
```

Copy the returned `database_id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "expense-db",
    "database_id": "<YOUR_DATABASE_ID>"
  }
]
```

Apply the database schema to your D1 instance:

```bash
# Execute on remote Cloudflare D1 database
npx wrangler d1 execute expense-db --remote --file=schema.sql
```

### 4. Configure Secrets

Set up required environment secrets on Cloudflare:

```bash
# Telegram Bot Token from @BotFather
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Google Gemini API Key
npx wrangler secret put GEMINI_API_KEY

# Your Telegram chat ID: only this chat can change the Gemini model via /model
npx wrangler secret put ADMIN_CHAT_ID
```

> `app_config` must exist in D1 (it is part of `schema.sql`); re-run the schema on existing databases.

### 5. Deploy to Cloudflare Workers

Deploy the worker to your Cloudflare account:

```bash
npm run deploy
```

Once deployed, Wrangler will print your Worker URL (e.g., `https://expense-bot.<your-subdomain>.workers.dev`).

### 6. Register Telegram Webhook

Link your Telegram Bot to your Cloudflare Worker:

```bash
curl -F "url=https://expense-bot.<your-subdomain>.workers.dev" \
  https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook
```

You can verify webhook health anytime:

```bash
curl https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/getWebhookInfo
```

---

## 📱 Apple Shortcut Integration

You can log expenses directly from iOS or macOS without opening Telegram:

1. Open the **Shortcuts** app on your iPhone or Mac.
2. Create a new Shortcut with the following actions:
   - **Ask for Input**: Text prompt `"What did you spend?"`
   - **Get Contents of URL**:
     - **URL**: `https://expense-bot.<your-subdomain>.workers.dev`
     - **Method**: `POST`
     - **Headers**: `Content-Type: application/json`
     - **Request Body**: `JSON`
       - `source` (Text): `shortcut`
       - `text` (Text): `Provided Input`
       - `user_id` (Text, optional): `<your-name>`
   - **Show Notification**: Display the text returned from the URL.
3. Assign the shortcut to your iPhone's **Action Button**, **Back Tap**, or home screen widget!

---

## 🧪 Testing & Code Quality

The project includes a comprehensive Vitest test suite covering all functions, routing flows, error resilience, and edge cases:

```bash
# Run unit tests
npm test -- --run

# Run TypeScript type check
npx tsc --noEmit && npx tsc -p test/tsconfig.json --noEmit

# Test Wrangler bundle build
npx wrangler deploy --dry-run
```

---

## 🔄 CI/CD Automation (GitHub Actions)

A GitHub Actions workflow is configured at `.github/workflows/deploy.yml` to automatically test and deploy your worker upon every push to the `main` branch.

### Setting up GitHub Secrets

1. Go to your GitHub repository: **Settings** > **Secrets and variables** > **Actions**.
2. Add the following repository secret:
   - `CLOUDFLARE_API_TOKEN`: A Cloudflare API Token with `Edit Cloudflare Workers` template permissions (generated from [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)).
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID (visible on Cloudflare Dashboard URL or `npx wrangler whoami`).

Once configured, any push or pull request merge into `main` will automatically run typechecks, execute the test suite, and deploy the latest worker code.

---

## 📄 License

MIT © [Nam Truong](https://github.com/namtruong244)
