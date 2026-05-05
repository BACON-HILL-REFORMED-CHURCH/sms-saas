# Deployment Guide

## Local Dev (recommended first step)

```bash
# 1. Start DB + Redis + Backend
docker-compose up -d

# 2. Start Frontend
cd frontend && npm run dev
```

---

## Production Setup

### Backend → VPS with Docker

```bash
# On your VPS (Ubuntu 22.04)
git clone <your-repo> && cd sms-saas
cp backend/.env.example backend/.env
# Fill in DATABASE_URL, JWT_SECRET, SMTP credentials, etc.

docker-compose -f docker-compose.yml up -d --build
```

### Frontend → Vercel

```bash
cd frontend
npx vercel --prod

# Set environment variable in Vercel dashboard:
# NEXT_PUBLIC_API_URL = https://api.yourdomain.com/api/v1
```

### Database → Supabase (free tier)

1. Create project at supabase.com
2. Copy the connection string (Transaction pooler)
3. Set `DATABASE_URL` in backend `.env`
4. Run: `cd backend && npx prisma migrate deploy`

### Redis → Upstash (free tier)

1. Create Redis DB at upstash.com
2. Copy `REDIS_URL` → set `REDIS_HOST` + `REDIS_PORT` + `REDIS_PASSWORD`

---

## Environment Variables Checklist

### Backend `.env`
| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_HOST` | Redis host |
| `REDIS_PORT` | Redis port (6379) |
| `REDIS_PASSWORD` | Redis auth (if any) |
| `JWT_SECRET` | Long random string (min 32 chars) |
| `JWT_EXPIRES_IN` | e.g. `7d` |
| `SMTP_HOST` | SMTP server |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `FRONTEND_URL` | e.g. `https://yourdomain.com` |

### Frontend `.env.local`
| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend API URL |
