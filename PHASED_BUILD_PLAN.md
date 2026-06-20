# Restaurant Ordering System Phased Build Plan

This plan turns the implementation outline into an execution path for building the full ordering system: application code, Neon PostgreSQL database, real-time kitchen updates, admin tools, billing, testing, deployment, and operations.

Important: keep the Neon PostgreSQL connection string in environment variables only. Do not commit it to source control. Use a local `.env` file for development and deployment secrets for production.

## Recommended Build Shape

- Frontend: Next.js, React, Tailwind CSS
- Backend: Node.js, Express, Socket.IO
- Database: PostgreSQL on Neon
- ORM/migrations: Prisma
- Authentication: JWT with bcrypt password hashing
- Validation: Zod
- Testing: Vitest or Jest for backend logic, Playwright for key flows
- Deployment: Vercel for frontend if split, Render/Railway/Fly.io/VPS for API and Socket.IO, Neon for PostgreSQL

For the first build, use a monorepo-style project with separate `apps/web` and `apps/api` directories, or a simpler two-folder structure:

```text
order/
  apps/
    api/
    web/
  packages/
    shared/
  docs/
  PHASED_BUILD_PLAN.md
```

## Phase 0: Project Foundation

Goal: create the codebase foundation, local environment, database connection, and repeatable development workflow.

Deliverables:

- Initialize Git repository if not already initialized.
- Create project structure.
- Scaffold backend API app.
- Scaffold frontend Next.js app.
- Add shared TypeScript types package if using a monorepo.
- Add `.env.example` files.
- Add formatting/linting.
- Add basic README with setup commands.
- Verify local API and frontend can run.

Environment variables:

```text
DATABASE_URL=
JWT_SECRET=
PORT=4000
CORS_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
```

Recommended commands:

```bash
npm create vite@latest apps/api
npx create-next-app@latest apps/web
npm install prisma @prisma/client
npm install express socket.io cors helmet dotenv bcrypt jsonwebtoken zod
```

Acceptance criteria:

- `apps/api` starts locally.
- `apps/web` starts locally.
- API health endpoint returns `200`.
- Environment variables are documented without exposing secrets.

## Phase 1: Database Design and Neon Setup

Goal: create the production-ready PostgreSQL schema and migration workflow.

Database entities:

- users
- dining_tables
- menu_categories
- menu_items
- orders
- order_items
- payments
- order_status_events

Core enum values:

```text
UserRole: ADMIN, MANAGER, WAITER, CHEF, CASHIER
TableStatus: AVAILABLE, OCCUPIED, RESERVED, OUT_OF_SERVICE
OrderStatus: DRAFT, SENT_TO_KITCHEN, RECEIVED, PREPARING, READY, SERVED, CANCELLED, PAID
PaymentStatus: UNPAID, PARTIAL, PAID, REFUNDED, VOID
PaymentMethod: CASH, CARD, MOBILE_MONEY, BANK_TRANSFER, OTHER
```

Schema requirements:

- Users need unique email, password hash, active flag, role, timestamps.
- Tables need unique table number and status.
- Menu items need name, category, price, availability, optional image URL, timestamps.
- Orders need table, waiter, status, total, timestamps.
- Order items need order, menu item snapshot name, price, quantity, note.
- Payments need order, amount, method, status, cashier, timestamps.
- Order status events should record every status change for audit and reporting.

Migration tasks:

- Add Prisma schema.
- Point Prisma to Neon using `DATABASE_URL`.
- Run initial migration.
- Add seed script for:
  - admin user
  - sample waiter, chef, cashier
  - sample tables
  - sample categories
  - sample menu items

Acceptance criteria:

- `prisma migrate dev` works locally.
- `prisma migrate deploy` works against Neon.
- Seed script creates usable test data.
- Database supports the full MVP order lifecycle.

## Phase 2: Backend API Foundation

Goal: implement backend structure, authentication, authorization, validation, and shared error handling.

Backend modules:

- `auth`
- `users`
- `tables`
- `menu`
- `orders`
- `payments`
- `reports`
- `socket`

Core middleware:

- JSON body parser
- CORS
- Helmet
- Request logging
- Authentication middleware
- Role authorization middleware
- Zod request validation
- Central error handler

Authentication endpoints:

```text
POST /auth/login
GET /auth/me
POST /auth/logout
```

Authorization rules:

- Admin/manager can manage users, menu, tables, reports.
- Waiter can create and view assigned/active orders.
- Chef can view kitchen orders and update kitchen statuses.
- Cashier can view payable orders and manage payments.

Acceptance criteria:

- Users can log in and receive JWT.
- Protected endpoints reject unauthenticated requests.
- Role-restricted endpoints reject unauthorized users.
- Errors return consistent JSON.

## Phase 3: MVP Order Flow API

Goal: build the core restaurant workflow from waiter order creation to kitchen status updates.

Menu endpoints:

```text
GET /menu/categories
GET /menu/items
GET /menu/items/:id
```

Table endpoints:

```text
GET /tables
GET /tables/:id
```

Order endpoints:

```text
POST /orders
GET /orders
GET /orders/:id
PATCH /orders/:id/status
GET /orders/history
```

Kitchen endpoints:

```text
GET /kitchen/orders
PATCH /kitchen/orders/:id/received
PATCH /kitchen/orders/:id/preparing
PATCH /kitchen/orders/:id/ready
PATCH /kitchen/orders/:id/cancel
```

Order creation rules:

- Waiter selects a table.
- Waiter adds one or more menu items.
- Backend calculates totals using current menu prices.
- Store menu item name and price snapshot on `order_items`.
- New orders start as `SENT_TO_KITCHEN`.
- Table becomes `OCCUPIED` when an active order exists.

Status transition rules:

```text
SENT_TO_KITCHEN -> RECEIVED -> PREPARING -> READY -> SERVED -> PAID
SENT_TO_KITCHEN -> CANCELLED
RECEIVED -> CANCELLED
PREPARING -> CANCELLED
```

Acceptance criteria:

- Waiter can create an order.
- Kitchen can fetch active orders.
- Chef can move order status forward.
- Waiter can see status changes.
- Invalid status jumps are rejected.

## Phase 4: Real-Time Socket.IO Layer

Goal: make order updates instant between waiter, kitchen, and cashier screens.

Socket rooms:

```text
kitchen
waiter:{userId}
table:{tableId}
cashier
managers
```

Events emitted by server:

```text
order:created
order:status_changed
order:item_updated
order:cancelled
payment:completed
table:status_changed
menu:item_availability_changed
```

Socket auth:

- Client connects with JWT.
- Server validates token.
- Server joins role-specific rooms.

Acceptance criteria:

- Kitchen receives new orders without refresh.
- Waiter receives status changes without refresh.
- Cashier receives ready/served orders without refresh.
- Disconnected clients recover by refetching current state.

## Phase 5: Frontend Foundation

Goal: create the app shell, auth flow, shared components, and role-based routing.

Frontend foundation:

- Login page.
- Auth storage and refresh-safe session handling.
- Role-aware navigation.
- API client.
- Socket client.
- Loading, empty, and error states.
- Toast notifications.

Main routes:

```text
/login
/waiter
/waiter/orders/:id
/kitchen
/cashier
/admin
/admin/menu
/admin/tables
/admin/users
/admin/reports
```

Acceptance criteria:

- Login redirects users to the correct role dashboard.
- Users cannot access pages outside their role.
- API errors are visible and understandable.
- App works on tablet, phone, and desktop widths.

## Phase 6: Waiter Panel

Goal: build the waiter ordering experience.

Features:

- Table selection.
- Menu category tabs.
- Menu search.
- Item cards with availability state.
- Cart fixed or easily accessible on tablets.
- Quantity increase/decrease.
- Special instructions per item.
- Submit order.
- Active order tracking.
- Status timeline.

UX requirements:

- Large touch targets.
- Fast item adding.
- Table number always visible during order creation.
- Clear confirmation when order is sent.

Acceptance criteria:

- Waiter can create a complete order in under a few taps.
- Cart total matches backend total.
- Unavailable items cannot be ordered.
- Status updates appear in real time.

## Phase 7: Kitchen Display

Goal: build the real-time kitchen screen.

Features:

- Dark-mode kitchen display.
- Large active order cards.
- Order age timer.
- Group items by order.
- Show table number, waiter name, notes, quantities.
- Status action buttons.
- Sound alert for new orders.
- Visual late indicator.

Acceptance criteria:

- New orders appear instantly.
- Chef can mark received, preparing, ready, or cancelled.
- Timers continue updating.
- Kitchen display is readable from a distance.

## Phase 8: Admin and Manager Tools

Goal: allow managers to maintain operational data.

Menu management:

- Create, edit, delete menu categories.
- Create, edit, delete menu items.
- Set prices.
- Set availability.

User management:

- Create staff users.
- Assign roles.
- Activate/deactivate users.
- Reset passwords.

Table management:

- Add/edit tables.
- Change table status.

Basic reports:

- Today's revenue.
- Active orders.
- Completed orders.
- Top-selling items.
- Staff activity.

Acceptance criteria:

- Admin can maintain all setup data without database access.
- Role restrictions are enforced.
- Reports match stored order/payment data.

## Phase 9: Billing and Cashier

Goal: complete the sales flow from served order to paid receipt.

Features:

- View served/ready orders.
- Generate bill by table or order.
- Add tax.
- Add service charge.
- Add discount.
- Select payment method.
- Mark as paid.
- Print receipt.

Payment rules:

- Payment amount must match payable total unless partial payments are intentionally enabled.
- Paid orders move to `PAID`.
- Paid tables return to `AVAILABLE` if no other active orders exist.
- Payment record stores cashier ID.

Receipt fields:

- Restaurant name.
- Date/time.
- Table number.
- Order number.
- Items, quantity, unit price, line total.
- Subtotal, tax, service charge, discount, final total.
- Payment method.

Acceptance criteria:

- Cashier can mark orders as paid.
- Receipt print view is usable.
- Daily sales include paid orders only.
- Paid order cannot be edited casually.

## Phase 10: Quality, Security, and Reliability

Goal: harden the system before real use.

Testing:

- Unit tests for status transitions and total calculations.
- API tests for auth and authorization.
- API tests for order creation and payment.
- Playwright tests for waiter to kitchen to cashier flow.
- Socket tests for real-time events where practical.

Security:

- Hash passwords with bcrypt.
- Store JWT secret outside code.
- Validate all inputs.
- Use role checks on every protected route.
- Avoid exposing database errors to users.
- Rate-limit login attempts.
- Add audit log for order status changes.

Reliability:

- Use database transactions for order creation and payment.
- Recalculate totals server-side.
- Add indexes on frequent filters.
- Handle Socket.IO reconnects.
- Add server health endpoint.

Acceptance criteria:

- Critical workflows have automated coverage.
- No known role bypasses.
- Database writes for orders/payments are transactional.
- App recovers gracefully after refresh or socket reconnect.

## Phase 11: Deployment

Goal: make the system available for real devices on a stable URL.

Deployment tasks:

- Create production Neon database branch or database.
- Add production environment variables.
- Run migrations against production.
- Seed only required admin/setup data.
- Deploy API with WebSocket support.
- Deploy frontend.
- Configure CORS to the production frontend URL.
- Configure HTTPS.
- Verify Socket.IO works in production.

Post-deploy checklist:

- Login as admin, waiter, chef, cashier.
- Create order from tablet/mobile width.
- Confirm kitchen receives order instantly.
- Move order through statuses.
- Generate bill.
- Mark paid.
- Check report totals.

Acceptance criteria:

- Production system supports at least one full real order cycle.
- Secrets are stored in platform secret managers.
- No database credentials are committed.

## Phase 12: Advanced Features

Goal: add optional capabilities after the core business workflow is stable.

Possible additions:

- QR menu.
- Customer self-ordering.
- Inventory tracking.
- Ingredient-level stock deductions.
- Advanced sales analytics.
- Offline order capture and later sync.
- Multi-branch support.
- Thermal printer integration.
- Kitchen station routing.
- Refunds and voids with manager approval.

Recommended order:

1. Receipt printer support.
2. Better reports and exports.
3. Item availability from kitchen.
4. Inventory tracking.
5. Offline support.
6. QR/customer ordering.
7. Multi-branch support.

## Initial Database Index Plan

Add indexes for common operational queries:

```text
users.email
users.role
dining_tables.table_number
menu_items.category_id
menu_items.available
orders.status
orders.table_id
orders.waiter_id
orders.created_at
order_items.order_id
payments.order_id
payments.status
payments.created_at
order_status_events.order_id
```

## Suggested MVP Sprint Breakdown

Sprint 1:

- Project setup.
- Prisma schema.
- Neon connection.
- Seed data.
- Auth API.

Sprint 2:

- Menu/table APIs.
- Order creation API.
- Kitchen status API.
- Socket.IO auth and events.

Sprint 3:

- Login UI.
- Waiter panel.
- Kitchen display.
- Real-time order updates.

Sprint 4:

- Admin menu/table/user basics.
- Cashier bill/payment basics.
- End-to-end testing.
- Deploy MVP.

## Definition of Done for MVP

The MVP is done when:

- Admin can log in and seed or manage basic menu/table/staff data.
- Waiter can create an order for a table.
- Kitchen receives that order instantly.
- Chef can update order status.
- Waiter sees status updates instantly.
- Cashier can mark a served order as paid.
- Database stores all users, menu items, orders, order items, status events, and payments.
- One full order cycle works in production.
