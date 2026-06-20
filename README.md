# Restaurant Ordering System

Working MVP for waiter ordering, kitchen updates, cashier payment, and admin reporting/menu availability.

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and fill in `DATABASE_URL` and `JWT_SECRET`.

3. Generate Prisma Client and migrate the database:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

4. Start API and web app:

```bash
npm run dev
```

API: `http://localhost:4000`

Web: `http://localhost:3000`

Role routes:

```text
http://localhost:3000/login
http://localhost:3000/admin
http://localhost:3000/waiter
http://localhost:3000/kitchen
http://localhost:3000/cashier
```

## Seeded Access

Admin users sign in with email and password. Staff users select their name from the access list.

```text
admin@restaurant.test / password123
waiter@restaurant.test / select name on Waiter Access
chef@restaurant.test / select name on Chef Access
cashier@restaurant.test / select name on Cashier Access
```

## Useful Commands

```bash
npm run build
npm run dev:api
npm run dev:web
npm run db:deploy
```
