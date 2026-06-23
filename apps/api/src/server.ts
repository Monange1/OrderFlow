import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import http from "node:http";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { z } from "zod";
import {
  OrderStatus,
  PaymentMethod,
  Prisma,
  PrismaClient,
  TableStatus,
  User,
  UserRole,
} from "@prisma/client";

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const jwtSecret = process.env.JWT_SECRET ?? "dev-secret";
const ntfyBaseUrl = (process.env.NTFY_BASE_URL ?? "https://ntfy.sh").replace(/\/$/, "");
const ntfyTopicSeed = crypto.createHash("sha256").update(jwtSecret).digest("hex").slice(0, 12);
const ntfyTopics = {
  kitchen: process.env.NTFY_TOPIC_KITCHEN ?? process.env.NTFY_TOPIC ?? `orderflow-${ntfyTopicSeed}-kitchen`,
  waiter: process.env.NTFY_TOPIC_WAITER ?? process.env.NTFY_TOPIC ?? `orderflow-${ntfyTopicSeed}-waiter`,
  cashier: process.env.NTFY_TOPIC_CASHIER ?? process.env.NTFY_TOPIC ?? `orderflow-${ntfyTopicSeed}-cashier`,
};
const ntfyEnabled = process.env.NTFY_ENABLED !== "false";

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    credentials: true,
  },
});

const transactionOptions = { timeout: 15000, maxWait: 15000 };

type AuthUser = Pick<User, "id" | "name" | "email" | "role" | "active">;
type TokenPayload = { sub: string; role: UserRole; email: string; name: string };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const activeStatuses: OrderStatus[] = [
  "SENT_TO_KITCHEN",
  "RECEIVED",
  "PREPARING",
  "READY",
  "SERVED",
];

const transitions: Record<OrderStatus, OrderStatus[]> = {
  SENT_TO_KITCHEN: ["RECEIVED", "PREPARING", "READY", "CANCELLED"],
  RECEIVED: ["PREPARING", "READY", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED", "CANCELLED"],
  SERVED: ["PAID", "CANCELLED"],
  CANCELLED: [],
  PAID: [],
};

const pendingOrders = new Map<
  string,
  {
    payload: any;
    waiterId: string;
    tableId: string;
    queuedStatus?: { status: OrderStatus; actorId?: string; note?: string };
  }
>();

let setupCache:
  | {
      expiresAt: number;
      tables: any[];
      categories: any[];
      availableItems: any[];
      allItems: any[];
      users: any[];
    }
  | undefined;
let activeOrdersCache: { expiresAt: number; orders: any[] } | undefined;
let summaryCache: { expiresAt: number; summary: any } | undefined;

function clearSetupCache() {
  setupCache = undefined;
}

function clearOrdersCache() {
  activeOrdersCache = undefined;
}

function clearSummaryCache() {
  summaryCache = undefined;
}

prisma.$connect().catch((error) => {
  console.error("Database connection failed", error);
});

setInterval(() => {
  prisma.$queryRaw`SELECT 1`.catch((error) => {
    console.error("Database keep-alive failed", error);
  });
}, 240_000).unref();

function orderLineSummary(order: any) {
  return order.items?.map((item: any) => `${item.quantity}x ${item.menuItemName}`).join(", ") ?? "Order items";
}

async function publishNtfy(topic: string, title: string, message: string, tags: string, priority = "urgent") {
  if (!ntfyEnabled) return { ok: false, skipped: true, message: "ntfy is disabled" };
  if (!topic) return { ok: false, skipped: true, message: "Missing ntfy topic" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(`${ntfyBaseUrl}/${encodeURIComponent(topic)}`, {
      method: "POST",
      signal: controller.signal,
      body: message,
      headers: {
        Title: title,
        Priority: priority,
        Tags: tags,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      console.error("ntfy publish failed", { status: response.status, topic, text });
      return { ok: false, status: response.status, message: text || response.statusText };
    }
    return { ok: true, status: response.status, topic };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ntfy error";
    console.error("ntfy publish failed", { topic, message });
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}

function notifyKitchenOrder(order: any) {
  void publishNtfy(
    ntfyTopics.kitchen,
    `New order: table ${order.table?.tableNumber ?? "?"}`,
    orderLineSummary(order),
    "fork_and_knife,receipt",
    "urgent",
  );
}

function notifyWaiterReady(order: any) {
  void publishNtfy(
    ntfyTopics.waiter,
    `Ready: table ${order.table?.tableNumber ?? "?"}`,
    orderLineSummary(order),
    "bell,white_check_mark",
    "urgent",
  );
}

app.use(helmet());
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

function signToken(user: AuthUser) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, name: user.name },
    jwtSecret,
    { expiresIn: "12h" },
  );
}

function publicUser(user: AuthUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
  };
}

function money(value: Prisma.Decimal | number | string) {
  return Number(value);
}

function serializeOrder(order: any) {
  return {
    ...order,
    subtotal: money(order.subtotal),
    tax: money(order.tax),
    serviceCharge: money(order.serviceCharge),
    discount: money(order.discount),
    totalPrice: money(order.totalPrice),
    items: order.items?.map((item: any) => ({
      ...item,
      unitPrice: money(item.unitPrice),
      lineTotal: money(item.lineTotal),
    })),
    payments: order.payments?.map((payment: any) => ({
      ...payment,
      amount: money(payment.amount),
    })),
  };
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret) as TokenPayload;
    req.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      role: payload.role,
      active: true,
    };
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

function authorize(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ message: "You do not have access to this action" });
      return;
    }

    next();
  };
}

async function orderInclude() {
  return {
    table: true,
    waiter: { select: { id: true, name: true, email: true, role: true } },
    items: { orderBy: { id: "asc" as const } },
  };
}

async function emitOrder(orderId: string, eventName = "order:status_changed") {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: await orderInclude(),
  });
  if (!order) return;

  const payload = serializeOrder(order);
  io.to("kitchen").emit(eventName, payload);
  io.to("cashier").emit(eventName, payload);
  io.to("managers").emit(eventName, payload);
  io.to(`waiter:${order.waiterId}`).emit(eventName, payload);
  io.to(`table:${order.tableId}`).emit(eventName, payload);
}

async function refreshTableStatus(tableId: string | null) {
  if (!tableId) return;
  const activeCount = await prisma.order.count({
    where: { tableId, status: { in: activeStatuses } },
  });
  const status: TableStatus = activeCount > 0 ? "OCCUPIED" : "AVAILABLE";
  const table = await prisma.diningTable.update({ where: { id: tableId }, data: { status } });
  io.emit("table:status_changed", table);
}

async function summaryReport() {
  if (summaryCache && summaryCache.expiresAt > Date.now()) return summaryCache.summary;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [paidOrders, activeOrders, payments, topItems] = await Promise.all([
    prisma.order.count({ where: { status: "PAID", updatedAt: { gte: today } } }),
    prisma.order.count({ where: { status: { in: activeStatuses } } }),
    prisma.payment.findMany({ where: { status: "PAID", createdAt: { gte: today } } }),
    prisma.orderItem.groupBy({
      by: ["menuItemName"],
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    }),
  ]);

  const summary = {
    paidOrders,
    activeOrders,
    todayRevenue: payments.reduce((sum, payment) => sum + money(payment.amount), 0),
    topItems: topItems.map((item) => ({
      name: item.menuItemName,
      quantity: item._sum.quantity ?? 0,
      revenue: money(item._sum.lineTotal ?? 0),
    })),
  };
  summaryCache = { expiresAt: Date.now() + 10_000, summary };
  return summary;
}

async function setupData() {
  if (setupCache && setupCache.expiresAt > Date.now()) return setupCache;

  const [tables, categories, availableItems, allItems, users] = await Promise.all([
    prisma.diningTable.findMany({ orderBy: { tableNumber: "asc" } }),
    prisma.menuCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.menuItem.findMany({
      where: { available: true },
      include: { category: true },
      orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
    }),
    prisma.menuItem.findMany({
      include: { category: true },
      orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
    }),
    prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, active: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    }),
  ]);

  setupCache = {
    expiresAt: Date.now() + 60_000,
    tables,
    categories,
    availableItems: availableItems.map((item) => ({ ...item, price: money(item.price) })),
    allItems: allItems.map((item) => ({ ...item, price: money(item.price) })),
    users,
  };
  return setupCache;
}

async function activeOrders() {
  if (activeOrdersCache && activeOrdersCache.expiresAt > Date.now()) return activeOrdersCache.orders;
  const orders = await prisma.order.findMany({
    where: { status: { in: activeStatuses } },
    include: await orderInclude(),
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  activeOrdersCache = { expiresAt: Date.now() + 3_000, orders: orders.map(serializeOrder) };
  return activeOrdersCache.orders;
}

function warmCaches() {
  Promise.all([setupData(), summaryReport(), activeOrders()]).catch((error) => {
    console.error("Cache warm failed", error);
  });
}

setTimeout(warmCaches, 1_000).unref();
setInterval(warmCaches, 55_000).unref();

async function changeOrderStatus(orderId: string, toStatus: OrderStatus, actorId?: string, note?: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    const pending = pendingOrders.get(orderId);
    if (!pending) throw Object.assign(new Error("Order not found"), { status: 404 });
    const fromStatus = pending.payload.status as OrderStatus;

    if (fromStatus === toStatus) return pending.payload;

    if (!transitions[fromStatus].includes(toStatus)) {
      throw Object.assign(new Error(`Cannot move order from ${fromStatus} to ${toStatus}`), { status: 400 });
    }

    pending.payload = { ...pending.payload, status: toStatus, updatedAt: new Date() };
    pending.queuedStatus = { status: toStatus, actorId, note };
    io.to("kitchen").emit("order:status_changed", pending.payload);
    io.to("cashier").emit("order:status_changed", pending.payload);
    io.to("managers").emit("order:status_changed", pending.payload);
    io.to(`waiter:${pending.waiterId}`).emit("order:status_changed", pending.payload);
    clearOrdersCache();
    clearSummaryCache();
    if (toStatus === "READY") notifyWaiterReady(pending.payload);
    return pending.payload;
  }

  if (order.status === toStatus) {
    const current = await prisma.order.findUnique({
      where: { id: orderId },
      include: await orderInclude(),
    });
    return current ?? order;
  }

  if (!transitions[order.status].includes(toStatus)) {
    throw Object.assign(new Error(`Cannot move order from ${order.status} to ${toStatus}`), { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.order.update({
      where: { id: orderId },
      data: { status: toStatus },
      include: await orderInclude(),
    });

    await tx.orderStatusEvent.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus,
        actorId,
        note,
      },
    });

    return next;
  }, transactionOptions);

  if (["SERVED", "PAID", "CANCELLED"].includes(toStatus)) {
    await refreshTableStatus(order.tableId);
  }
  clearOrdersCache();
  clearSummaryCache();
  await emitOrder(orderId);
  if (toStatus === "READY") notifyWaiterReady(serializeOrder(updated));
  return updated;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ordering-api" });
});

app.get(
  "/notifications/topics",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  (_req, res) => {
    res.json({ enabled: ntfyEnabled, baseUrl: ntfyBaseUrl, topics: ntfyTopics });
  },
);

app.post(
  "/notifications/test",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z.object({ target: z.enum(["kitchen", "waiter", "cashier"]) }).parse(req.body);
    const title =
      body.target === "kitchen"
        ? "Test kitchen push"
        : body.target === "waiter"
          ? "Test waiter push"
          : "Test cashier push";
    const message =
      body.target === "kitchen"
        ? "Kitchen phones should receive this when a waiter sends an order."
        : body.target === "waiter"
          ? "Waiter phones should receive this when the chef marks food ready."
          : "Cashier phones should receive payment alerts.";

    const result = await publishNtfy(ntfyTopics[body.target], title, message, "bell,test_tube", "urgent");
    if (!result.ok) {
      res.status(502).json({ message: result.message ?? "Push notification failed", result });
      return;
    }
    res.json({ message: `Test push sent to ${body.target}`, result });
  }),
);

app.get(
  "/bootstrap/waiter",
  authenticate,
  authorize("WAITER", "ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const [setup, orders] = await Promise.all([setupData(), activeOrders()]);
    const visibleOrders = req.user?.role === "WAITER" ? orders.filter((order) => order.waiterId === req.user?.id) : orders;

    res.json({
      tables: setup.tables,
      categories: setup.categories,
      items: setup.availableItems,
      orders: visibleOrders,
    });
  }),
);

app.get(
  "/bootstrap/admin",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (_req, res) => {
    const [summary, setup] = await Promise.all([summaryReport(), setupData()]);

    res.json({
      summary,
      notifications: { enabled: ntfyEnabled, baseUrl: ntfyBaseUrl, topics: ntfyTopics },
      users: setup.users,
      tables: setup.tables,
      categories: setup.categories,
      items: setup.allItems,
    });
  }),
);

app.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    if (!user || !user.active || !(await bcrypt.compare(body.password, user.passwordHash))) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    const safeUser = publicUser(user);
    res.json({ token: signToken(safeUser), user: safeUser });
  }),
);

app.post(
  "/auth/admin-login",
  asyncHandler(async (req, res) => {
    const body = z.object({ password: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findFirst({
      where: { role: "ADMIN", active: true },
      orderBy: { createdAt: "asc" },
    });

    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      res.status(401).json({ message: "Invalid admin password" });
      return;
    }

    const safeUser = publicUser(user);
    res.json({ token: signToken(safeUser), user: safeUser });
  }),
);

app.get(
  "/auth/staff",
  asyncHandler(async (req, res) => {
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const allowedRoles: UserRole[] = ["WAITER", "CHEF", "CASHIER"];
    const requestedRole = allowedRoles.includes(role as UserRole) ? (role as UserRole) : undefined;

    const users = await prisma.user.findMany({
      where: { active: true, role: requestedRole ? requestedRole : { in: allowedRoles } },
      select: { id: true, name: true, email: true, role: true, active: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    });

    res.json({ users });
  }),
);

app.post(
  "/auth/staff-login",
  asyncHandler(async (req, res) => {
    const body = z.object({ userId: z.string().min(1), role: z.enum(["WAITER", "CHEF", "CASHIER"]) }).parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: body.userId },
      select: { id: true, name: true, email: true, role: true, active: true },
    });

    if (!user?.active || user.role !== body.role) {
      res.status(401).json({ message: "This user does not have access to that workspace" });
      return;
    }

    res.json({ token: signToken(user), user });
  }),
);

app.get("/auth/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

app.get(
  "/users",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, active: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    });
    res.json({ users });
  }),
);

app.post(
  "/users",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        email: z.string().email().optional(),
        role: z.nativeEnum(UserRole),
        password: z.string().min(6).optional(),
      })
      .parse(req.body);

    if (["ADMIN", "MANAGER"].includes(body.role) && !body.password) {
      res.status(400).json({ message: "Admin and manager users need a password" });
      return;
    }

    const generatedEmail = `${body.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}.${Date.now()}@staff.local`;
    const passwordHash = await bcrypt.hash(body.password ?? crypto.randomUUID(), 10);
    const user = await prisma.user.create({
      data: { name: body.name, email: body.email ?? generatedEmail, role: body.role, passwordHash },
      select: { id: true, name: true, email: true, role: true, active: true },
    });

    clearSetupCache();
    res.status(201).json({ user });
  }),
);

app.get(
  "/tables",
  authenticate,
  asyncHandler(async (_req, res) => {
    const tables = await prisma.diningTable.findMany({ orderBy: { tableNumber: "asc" } });
    res.json({ tables });
  }),
);

app.post(
  "/tables",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z.object({ tableNumber: z.string().min(1), seats: z.number().int().min(1).default(4) }).parse(req.body);
    const table = await prisma.diningTable.create({ data: body });
    clearSetupCache();
    res.status(201).json({ table });
  }),
);

app.put(
  "/tables/setup",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z.object({ count: z.number().int().min(1).max(200), seats: z.number().int().min(1).max(30).default(4) }).parse(req.body);

    const activeOrders = await prisma.order.count({ where: { status: { in: activeStatuses } } });
    if (activeOrders > 0) {
      res.status(400).json({ message: "Finish or cancel active orders before changing table count" });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.diningTable.deleteMany({
        where: {
          tableNumber: { notIn: Array.from({ length: body.count }, (_value, index) => String(index + 1)) },
        },
      });

      for (let i = 1; i <= body.count; i += 1) {
        await tx.diningTable.upsert({
          where: { tableNumber: String(i) },
          update: { seats: body.seats },
          create: { tableNumber: String(i), seats: body.seats },
        });
      }
    }, transactionOptions);

    const tables = await prisma.diningTable.findMany({ orderBy: { tableNumber: "asc" } });
    clearSetupCache();
    io.emit("table:status_changed", { setup: true, tables });
    res.json({ tables });
  }),
);

app.get(
  "/menu/categories",
  authenticate,
  asyncHandler(async (_req, res) => {
    const categories = await prisma.menuCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    res.json({ categories });
  }),
);

app.post(
  "/menu/categories",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1), sortOrder: z.number().int().default(0) }).parse(req.body);
    const category = await prisma.menuCategory.create({ data: body });
    clearSetupCache();
    res.status(201).json({ category });
  }),
);

app.get(
  "/menu/items",
  authenticate,
  asyncHandler(async (req, res) => {
    const items = await prisma.menuItem.findMany({
      where: req.query.available === "true" ? { available: true } : undefined,
      include: { category: true },
      orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
    });
    res.json({ items: items.map((item) => ({ ...item, price: money(item.price) })) });
  }),
);

app.post(
  "/menu/items",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        price: z.number().positive(),
        categoryId: z.string().min(1),
        available: z.boolean().default(true),
      })
      .parse(req.body);
    const item = await prisma.menuItem.create({ data: { ...body, price: body.price.toFixed(2) }, include: { category: true } });
    clearSetupCache();
    io.emit("menu:item_availability_changed", { id: item.id, available: item.available });
    res.status(201).json({ item: { ...item, price: money(item.price) } });
  }),
);

app.patch(
  "/menu/items/:id",
  authenticate,
  authorize("ADMIN", "MANAGER", "CHEF"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        price: z.number().positive().optional(),
        categoryId: z.string().min(1).optional(),
        available: z.boolean().optional(),
      })
      .parse(req.body);
    const itemId = String(req.params.id);
    const item = await prisma.menuItem.update({
      where: { id: itemId },
      data: { ...body, price: body.price?.toFixed(2) },
      include: { category: true },
    });
    clearSetupCache();
    io.emit("menu:item_availability_changed", { id: item.id, available: item.available });
    res.json({ item: { ...item, price: money(item.price) } });
  }),
);

app.post(
  "/orders",
  authenticate,
  authorize("WAITER", "ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        orderType: z.enum(["DINE_IN", "TAKEAWAY"]).default("DINE_IN"),
        customerName: z.string().optional(),
        tableId: z.string().optional(),
        notes: z.string().optional(),
        items: z
          .array(
            z.object({
              menuItemId: z.string().min(1),
              quantity: z.number().int().min(1),
              note: z.string().optional(),
              menuItemName: z.string().min(1).optional(),
              unitPrice: z.number().positive().optional(),
            }),
          )
          .min(1),
        tableNumber: z.string().optional(),
      })
      .parse(req.body);

    if (body.orderType === "DINE_IN" && !body.tableId) {
      res.status(400).json({ message: "Dine-in orders require a table" });
      return;
    }
    if (body.orderType === "TAKEAWAY" && !body.customerName) {
      res.status(400).json({ message: "Takeaway orders require a customer name" });
      return;
    }

    const canFastAck = body.items.every((item) => item.menuItemName && item.unitPrice);

    if (canFastAck) {
      const orderId = crypto.randomUUID();
      const now = new Date();
      const preparedItems = body.items.map((item) => {
        const unitPrice = item.unitPrice!;
        const lineTotal = unitPrice * item.quantity;
        return {
          id: `${orderId}-${item.menuItemId}`,
          orderId,
          menuItemId: item.menuItemId,
          menuItemName: item.menuItemName!,
          quantity: item.quantity,
          note: item.note,
          unitPrice,
          lineTotal,
        };
      });
      const subtotal = preparedItems.reduce((sum, item) => sum + item.lineTotal, 0);
      const payload = {
        id: orderId,
        orderType: body.orderType,
        customerName: body.customerName,
        tableId: body.tableId || null,
        waiterId: req.user!.id,
        status: "SENT_TO_KITCHEN",
        subtotal,
        tax: 0,
        serviceCharge: 0,
        discount: 0,
        totalPrice: subtotal,
        notes: body.notes,
        createdAt: now,
        updatedAt: now,
        table: body.tableId ? {
          id: body.tableId,
          tableNumber: body.tableNumber ?? "?",
          status: "OCCUPIED",
          seats: 0,
          createdAt: now,
          updatedAt: now,
        } : null,
        waiter: publicUser(req.user!),
        items: preparedItems,
        payments: [],
        statusEvents: [],
      };

      pendingOrders.set(orderId, {
        payload,
        waiterId: req.user!.id,
        tableId: body.tableId || "",
      });
      io.to("kitchen").emit("order:created", payload);
      io.to("managers").emit("order:created", payload);
      io.to(`waiter:${req.user!.id}`).emit("order:created", payload);
      if (body.orderType === "DINE_IN" && body.tableId) {
        io.emit("table:status_changed", { id: body.tableId, status: "OCCUPIED" });
      }
      notifyKitchenOrder(payload);
      clearOrdersCache();
      clearSummaryCache();
      res.status(201).json({ order: payload });

      prisma
        .$transaction(async (tx) => {
          await tx.order.create({
            data: {
              id: orderId,
              orderType: body.orderType,
              customerName: body.customerName,
              tableId: body.tableId || null,
              waiterId: req.user!.id,
              notes: body.notes,
              subtotal: subtotal.toFixed(2),
              totalPrice: subtotal.toFixed(2),
              items: {
                create: preparedItems.map((item) => ({
                  menuItemId: item.menuItemId,
                  menuItemName: item.menuItemName,
                  quantity: item.quantity,
                  note: item.note,
                  unitPrice: item.unitPrice.toFixed(2),
                  lineTotal: item.lineTotal.toFixed(2),
                })),
              },
              statusEvents: {
                create: { toStatus: "SENT_TO_KITCHEN", actorId: req.user!.id, note: "Order sent to kitchen" },
              },
            },
          });
          if (body.orderType === "DINE_IN" && body.tableId) {
            await tx.diningTable.update({ where: { id: body.tableId }, data: { status: "OCCUPIED" } });
          }

          const pending = pendingOrders.get(orderId);
          if (pending?.queuedStatus) {
            await tx.order.update({ where: { id: orderId }, data: { status: pending.queuedStatus.status } });
            await tx.orderStatusEvent.create({
              data: {
                orderId,
                fromStatus: "SENT_TO_KITCHEN",
                toStatus: pending.queuedStatus.status,
                actorId: pending.queuedStatus.actorId,
                note: pending.queuedStatus.note,
              },
            });
          }
        }, transactionOptions)
        .then(async () => {
          pendingOrders.delete(orderId);
          clearOrdersCache();
          clearSummaryCache();
          await emitOrder(orderId);
        })
        .catch((error) => {
          pendingOrders.delete(orderId);
          console.error("Background order persistence failed", error);
          io.to(`waiter:${req.user!.id}`).emit("order:failed", { orderId, message: "Order could not be saved" });
          io.to("kitchen").emit("order:failed", { orderId, message: "Order could not be saved" });
        });
      return;
    }

    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: body.items.map((item) => item.menuItemId) }, available: true },
    });
    const menuById = new Map(menuItems.map((item) => [item.id, item]));

    if (menuItems.length !== new Set(body.items.map((item) => item.menuItemId)).size) {
      res.status(400).json({ message: "One or more menu items are unavailable" });
      return;
    }

    const preparedItems = body.items.map((item) => {
      const menuItem = menuById.get(item.menuItemId);
      if (!menuItem) throw new Error("Menu item missing");
      const unitPrice = money(menuItem.price);
      const lineTotal = unitPrice * item.quantity;
      return {
        menuItemId: item.menuItemId,
        menuItemName: menuItem.name,
        quantity: item.quantity,
        note: item.note,
        unitPrice: unitPrice.toFixed(2),
        lineTotal: lineTotal.toFixed(2),
      };
    });

    const subtotal = preparedItems.reduce((sum, item) => sum + Number(item.lineTotal), 0);

    const txOperations: any[] = [
      prisma.order.create({
        data: {
          orderType: body.orderType,
          customerName: body.customerName,
          tableId: body.tableId || null,
          waiterId: req.user!.id,
          notes: body.notes,
          subtotal: subtotal.toFixed(2),
          totalPrice: subtotal.toFixed(2),
          items: { create: preparedItems },
          statusEvents: {
            create: { toStatus: "SENT_TO_KITCHEN", actorId: req.user!.id, note: "Order sent to kitchen" },
          },
        },
      }),
    ];

    if (body.orderType === "DINE_IN" && body.tableId) {
      txOperations.push(
        prisma.diningTable.update({ where: { id: body.tableId }, data: { status: "OCCUPIED" } })
      );
    }

    const txResults = await prisma.$transaction(txOperations);
    const order = txResults[0];
    const table = body.orderType === "DINE_IN" ? txResults[1] : null;

    const payload = {
      ...order,
      subtotal,
      tax: 0,
      serviceCharge: 0,
      discount: 0,
      totalPrice: subtotal,
      table,
      waiter: publicUser(req.user!),
      items: preparedItems.map((item) => ({
        id: `${order.id}-${item.menuItemId}`,
        orderId: order.id,
        ...item,
        unitPrice: Number(item.unitPrice),
        lineTotal: Number(item.lineTotal),
      })),
      payments: [],
      statusEvents: [],
    };
    io.to("kitchen").emit("order:created", payload);
    io.to("managers").emit("order:created", payload);
    io.to(`waiter:${order.waiterId}`).emit("order:created", payload);
    if (body.orderType === "DINE_IN" && body.tableId) {
      io.emit("table:status_changed", { id: body.tableId, status: "OCCUPIED" });
    }
    notifyKitchenOrder(payload);
    clearOrdersCache();
    clearSummaryCache();
    res.status(201).json({ order: payload });
  }),
);

app.get(
  "/orders",
  authenticate,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? (req.query.status as OrderStatus) : undefined;
    const where: Prisma.OrderWhereInput = {};
    if (status) where.status = status;
    else where.status = { in: activeStatuses };
    if (req.user?.role === "WAITER") where.waiterId = req.user.id;

    const orders = await prisma.order.findMany({
      where,
      include: await orderInclude(),
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ orders: orders.map(serializeOrder) });
  }),
);

app.get(
  "/kitchen/orders",
  authenticate,
  authorize("CHEF", "ADMIN", "MANAGER"),
  asyncHandler(async (_req, res) => {
    const orders = await prisma.order.findMany({
      where: { status: { in: ["SENT_TO_KITCHEN", "RECEIVED", "PREPARING"] } },
      include: await orderInclude(),
      orderBy: { createdAt: "asc" },
    });
    res.json({ orders: orders.map(serializeOrder) });
  }),
);

app.patch(
  "/orders/:id/status",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.nativeEnum(OrderStatus), note: z.string().optional() }).parse(req.body);
    const status = body.status;

    const allowed =
      req.user?.role === "CHEF"
        ? ["RECEIVED", "PREPARING", "READY", "CANCELLED"].includes(status)
        : req.user?.role === "WAITER"
          ? status === "SERVED"
          : ["ADMIN", "MANAGER"].includes(req.user?.role ?? "");

    if (!allowed) {
      res.status(403).json({ message: "This role cannot set that order status" });
      return;
    }

    const updated = await changeOrderStatus(String(req.params.id), status, req.user!.id, body.note);
    res.json({ order: serializeOrder(updated) });
  }),
);

app.post(
  "/payments",
  authenticate,
  authorize("CASHIER", "ADMIN", "MANAGER", "WAITER"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        orderId: z.string().min(1),
        method: z.nativeEnum(PaymentMethod),
        amount: z.number().positive().optional(),
      })
      .parse(req.body);

    const order = await prisma.order.findUnique({ where: { id: body.orderId }, include: { payments: true } });
    if (!order) {
      res.status(404).json({ message: "Order not found" });
      return;
    }
    if (!["SERVED", "READY"].includes(order.status)) {
      res.status(400).json({ message: "Only ready or served orders can be paid" });
      return;
    }

    const amount = body.amount ?? money(order.totalPrice);
    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          orderId: body.orderId,
          cashierId: req.user!.id,
          amount: amount.toFixed(2),
          method: body.method,
          status: "PAID",
        },
      });

      await tx.order.update({ where: { id: body.orderId }, data: { status: "PAID" } });
      await tx.orderStatusEvent.create({
        data: { orderId: body.orderId, fromStatus: order.status, toStatus: "PAID", actorId: req.user!.id },
      });
      return created;
    }, transactionOptions);

    await refreshTableStatus(order.tableId);
    clearOrdersCache();
    clearSummaryCache();
    await emitOrder(body.orderId, "payment:completed");
    res.status(201).json({ payment: { ...payment, amount: money(payment.amount) } });
  }),
);

app.get(
  "/reports/summary",
  authenticate,
  authorize("ADMIN", "MANAGER"),
  asyncHandler(async (_req, res) => {
    res.json(await summaryReport());
  }),
);

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) throw new Error("Missing token");
    const payload = jwt.verify(token, jwtSecret) as TokenPayload;
    socket.data.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      role: payload.role,
      active: true,
    };
    next();
  } catch {
    next(new Error("Socket authentication failed"));
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user as AuthUser;
  socket.join(`waiter:${user.id}`);

  if (["CHEF", "ADMIN", "MANAGER"].includes(user.role)) socket.join("kitchen");
  if (["CASHIER", "ADMIN", "MANAGER"].includes(user.role)) socket.join("cashier");
  if (["ADMIN", "MANAGER"].includes(user.role)) socket.join("managers");

  socket.on("table:join", (tableId: string) => {
    socket.join(`table:${tableId}`);
  });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ message: "Validation failed", issues: error.issues });
    return;
  }

  const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error";
  res.status(status || 500).json({ message });
});

server.listen(port, () => {
  console.log(`Ordering API listening on http://localhost:${port}`);
});
