# SMS SaaS Platform

> Virtual phone number activation platform — built with NestJS, Next.js 14, PostgreSQL, Redis.

## Monorepo Structure

```
sms-saas/
├── backend/          # NestJS API (Port 3001)
│   ├── src/
│   │   ├── prisma/   # Database service
│   │   ├── redis/    # Cache service
│   │   ├── auth/     # Step 2 — JWT auth
│   │   ├── users/    # Step 3 — Users
│   │   ├── wallet/   # Step 3 — Wallet
│   │   ├── providers/# Step 4 — Provider system
│   │   ├── orders/   # Step 5-6 — Orders & SMS
│   │   └── admin/    # Step 7 — Admin panel
│   └── prisma/
│       └── schema.prisma
│
├── frontend/         # Next.js 14 + Tailwind (Port 3000)
│   └── src/
│       ├── app/      # App router pages
│       ├── components/
│       └── lib/      # API client, utils
│
└── shared/           # TypeScript types shared between apps
    └── src/types/
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local

# 3. Run database migrations
cd backend && npm run db:migrate

# 4. Start development servers
npm run dev:backend   # http://localhost:3001
npm run dev:frontend  # http://localhost:3000
```

## Build Steps
- [x] Step 1 — Monorepo structure
- [ ] Step 2 — Auth system
- [ ] Step 3 — Wallet system
- [ ] Step 4 — Provider abstraction
- [ ] Step 5 — SMS activation flow
- [ ] Step 6 — Orders system
- [ ] Step 7 — Admin panel
- [ ] Step 8 — Frontend pages
- [ ] Step 9 — Security
- [ ] Step 10 — Deployment
