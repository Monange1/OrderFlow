# Production Restaurant Ordering Rebuild Blueprint

This rebuild is based on observed patterns from production restaurant POS and KDS systems, including Toast, Square for Restaurants, TouchBistro/Fresh KDS, and Lightspeed Restaurant.

## Research Notes

### Toast POS Ordering

Source: https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens

Useful patterns:

- The order screen is organized around menu groups, item search, and a live check/ticket.
- Table service screens prioritize table context and check details.
- Staff should be able to send items to the kitchen without leaving the order screen.
- The check area is always visible enough for the server to understand what will be sent.

Implementation decisions:

- Waiter screen must be a three-part layout: table context, menu browser, live ticket.
- Sending an order must be optimistic and immediate.
- Item search and category filters must be prominent.

### Toast KDS

Source: https://doc.toasttab.com/doc/platformguide/platformKDSOverview.html

Useful patterns:

- KDS replaces printed tickets and updates in real time.
- New/changed tickets should be signaled visually and audibly.
- Ticket age and status colors matter.
- A completed kitchen ticket should notify front of house.
- Expediter workflow is different from prep-station workflow, but MVP should use a single expediter screen.

Implementation decisions:

- Kitchen screen is a queue, not a dashboard.
- New ticket alert must be visible and audible.
- Chef action should be one primary button: `Ready`.
- Waiter receives a clear ready notification.

### Square for Restaurants

Sources:

- https://squareup.com/help/us/en/article/7748-coursing-with-square-kds
- https://squareup.com/gb/en/point-of-sale/restaurants/features/table-management-system

Useful patterns:

- Table/floor management is a first-class restaurant workflow.
- Coursing lets staff group, hold, and fire items.
- Kitchen tickets should be routed and timed.
- Staff, tables, menu, and kitchen setup are admin-owned.

Implementation decisions:

- Admin setup must include tables, staff, categories, and menu before service.
- MVP can skip full floor-plan drag/drop, but table setup must be explicit.
- Future version should support courses, holds, and item routing.

### TouchBistro / Fresh KDS

Source: https://www.touchbistro.com/blog/benefit-of-touchbistro-kds/

Useful patterns:

- Orders from POS appear immediately on KDS.
- KDS uses audible alerts.
- Tickets use color-coded statuses and ticket timers.
- Tickets should be easy to clear.
- Ticket history matters for correcting mistakes.

Implementation decisions:

- Order send must acknowledge immediately and persist in background.
- KDS tickets need timers.
- Completed tickets should leave the main queue but remain in history later.

### Lightspeed Restaurant KDS

Sources:

- https://www.lightspeedhq.com/pos/restaurant/kitchen-display-system/
- https://k-series-support.lightspeedhq.com/hc/en-us/articles/22168531609499-Setting-up-Kitchen-Display-System-2-0

Useful patterns:

- KDS should display all active orders on one clear screen.
- Orders need real-time updates, statuses, timestamps, and preparation state.
- Multiple prep stations can come later, but single station must be excellent first.
- KDS should work on browser-capable screens.

Implementation decisions:

- Kitchen view must be big, readable, and touch-friendly.
- Use ticket columns: new/active/ready history later.
- Use elapsed time prominently.

## Target Product Model

### Roles

- Admin: password access only.
- Waiter: tap name, no password.
- Chef/Kitchen: tap name, no password.
- Cashier: tap name, no password.

### Setup Flow

Admin first-run checklist:

1. Create staff.
2. Create tables.
3. Create categories.
4. Create menu items.
5. Open service.

No hard-coded staff, tables, categories, menu items, or orders.

### Waiter Workflow

1. Tap waiter name.
2. See table board.
3. Select table.
4. Add menu items from category/search grid.
5. Review ticket.
6. Tap `Send`.
7. Ticket appears immediately in kitchen queue.
8. Waiter sees order status and receives ready notification.

### Kitchen Workflow

1. Tap chef name.
2. See active queue only.
3. New order appears instantly with sound/visual alert.
4. Chef prepares food.
5. Chef taps one button: `Ready`.
6. Ticket leaves kitchen queue.
7. Waiter receives ready notification.

### Cashier Workflow

1. Tap cashier name.
2. See ready/served checks.
3. Open bill.
4. Mark paid.

### Performance Rule

Every staff action must visibly respond in under 500ms.

Order send must:

- Return an optimistic confirmation immediately.
- Push to kitchen immediately.
- Persist in background.
- Show clear failure notification if persistence fails.

## UI Direction

The UI should feel like a modern restaurant operations tool:

- Calm, touch-friendly, bright, and fast.
- No technical language on staff screens.
- No giant forms unless in admin setup.
- Strong table and ticket metaphors.
- Large kitchen tickets with timers.
- Clear empty states and loading states.
- Responsive tablet-first layout.

## Rebuild Scope

### Frontend Replace

Replace the current screen structure with:

- `AccessScreen`
- `AdminSetup`
- `WaiterService`
- `KitchenQueue`
- `CashierDesk`
- shared components:
  - `TopBar`
  - `StatusToast`
  - `LoadingPulse`
  - `PersonTile`
  - `TableTile`
  - `MenuTile`
  - `OrderTicket`
  - `KitchenTicket`

### Backend Keep And Harden

Keep:

- Prisma schema
- Auth/session endpoints
- Socket.IO rooms
- Fast-ack order send

Improve:

- Idempotency key for order sends.
- Order failure events.
- Proper order history.
- Role-specific API response shapes.

## Acceptance Criteria

The rebuild is acceptable when:

- First screen looks like a real POS access screen.
- Admin setup starts empty and can configure the restaurant.
- Waiter can send an order in under 2 seconds from click to visible confirmation.
- Kitchen receives order instantly.
- Chef only clicks `Ready`.
- Waiter receives a ready notification.
- No duplicated tickets.
- All loading states are visible.
- All empty states are useful.
- All screens are usable on tablet and desktop.
