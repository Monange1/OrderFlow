import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import {
  Banknote,
  Bell,
  Check,
  ChefHat,
  ClipboardList,
  CreditCard,
  DoorOpen,
  Grid3X3,
  Loader2,
  LogOut,
  Minus,
  Plus,
  Search,
  Settings,
  Sparkles,
  UserRound,
  Utensils,
  Volume2,
} from "lucide-react";
import "./styles.css";

type Role = "ADMIN" | "MANAGER" | "WAITER" | "CHEF" | "CASHIER";
type View = "login" | "waiter" | "kitchen" | "cashier" | "admin";
type User = { id: string; name: string; email: string; role: Role; active?: boolean };
type Category = { id: string; name: string; sortOrder: number };
type Table = { id: string; tableNumber: string; status: string; seats: number };
type MenuItem = {
  id: string;
  name: string;
  description?: string;
  price: number;
  available: boolean;
  categoryId: string;
  category: Category;
};
type OrderItem = {
  id: string;
  menuItemId: string;
  menuItemName: string;
  quantity: number;
  note?: string;
  unitPrice: number;
  lineTotal: number;
};
type Order = {
  id: string;
  orderType: "DINE_IN" | "TAKEAWAY";
  customerName?: string;
  status: string;
  subtotal: number;
  totalPrice: number;
  notes?: string;
  createdAt: string;
  updatedAt?: string;
  table?: Table;
  waiter: User;
  items: OrderItem[];
};
type CartRow = { item: MenuItem; quantity: number; note: string };
type Summary = {
  paidOrders: number;
  activeOrders: number;
  todayRevenue: number;
  topItems: Array<{ name: string; quantity: number; revenue: number }>;
};
type NotificationTopics = {
  enabled: boolean;
  baseUrl: string;
  topics: { kitchen: string; waiter: string; cashier: string };
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? API_URL;
const activeKitchenStatuses = ["SENT_TO_KITCHEN", "RECEIVED", "PREPARING"];
const billStatuses = ["READY", "SERVED"];

type ApiOptions = RequestInit & { timeoutMs?: number };

function apiFetch<T>(path: string, token = "", options: ApiOptions = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;

  return fetch(`${API_URL}${path}`, {
    ...fetchOptions,
    signal: fetchOptions.signal ?? controller.signal,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...fetchOptions.headers,
    },
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? "Request failed");
      return data as T;
    })
    .catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Still waiting on the database. Refresh if this does not update.");
      }
      throw error;
    })
    .finally(() => window.clearTimeout(timeout));
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function roleHome(role: Role): View {
  if (role === "WAITER") return "waiter";
  if (role === "CHEF") return "kitchen";
  if (role === "CASHIER") return "cashier";
  return "admin";
}

function viewFromPath(): View {
  const value = window.location.pathname.replace("/", "");
  return ["waiter", "kitchen", "cashier", "admin"].includes(value) ? (value as View) : "login";
}

function pathForView(view: View) {
  return view === "login" ? "/login" : `/${view}`;
}

function canAccess(role: Role, view: View) {
  if (view === "login") return true;
  if (["ADMIN", "MANAGER"].includes(role)) return true;
  return roleHome(role) === view;
}

function sortNewest(orders: Order[]) {
  return [...orders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function sortOldest(orders: Order[]) {
  return [...orders].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function upsertOrder(current: Order[], order: Order) {
  const map = new Map(current.map((row) => [row.id, row]));
  map.set(order.id, order);
  return sortNewest(Array.from(map.values()));
}

function minutesWaiting(order: Order) {
  return Math.max(0, Math.floor((Date.now() - new Date(order.createdAt).getTime()) / 60000));
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").toLowerCase();
}

function useClock(interval = 30000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
}

function playNoticeTone() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const audio = new AudioContextClass();
    const master = audio.createGain();
    master.gain.value = 0.08;
    master.connect(audio.destination);

    const notes = [
      { frequency: 659.25, start: 0, length: 0.16 },
      { frequency: 880, start: 0.08, length: 0.18 },
      { frequency: 1174.66, start: 0.18, length: 0.26 },
    ];

    notes.forEach((note) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency;
      gain.gain.setValueAtTime(0, audio.currentTime + note.start);
      gain.gain.linearRampToValueAtTime(0.9, audio.currentTime + note.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + note.start + note.length);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(audio.currentTime + note.start);
      oscillator.stop(audio.currentTime + note.start + note.length + 0.03);
    });
  } catch {
    // Browsers may block audio until the first tap.
  }
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("token") ?? "");
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem("user");
    return raw ? JSON.parse(raw) : null;
  });
  const [view, setView] = useState<View>(() => viewFromPath());
  const [checking, setChecking] = useState(true);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [notice, setNotice] = useState("");

  function go(next: View, replace = false) {
    setView(next);
    const path = pathForView(next);
    if (window.location.pathname !== path) {
      window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    }
  }

  function notify(message: string, audible = true) {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? "" : current)), 4200);
    if (audible) playNoticeTone();

    if ("Notification" in window) {
      if (Notification.permission === "granted") new Notification("OrderFlow", { body: message });
      if (Notification.permission === "default") Notification.requestPermission().catch(() => undefined);
    }
  }

  function onLogin(nextToken: string, nextUser: User) {
    localStorage.setItem("token", nextToken);
    localStorage.setItem("user", JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
    go(roleHome(nextUser.role), true);
  }

  function logout() {
    socket?.disconnect();
    localStorage.clear();
    setToken("");
    setUser(null);
    setNotice("");
    go("login", true);
  }

  useEffect(() => {
    const onPop = () => setView(viewFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!token || !user) {
      setChecking(false);
      return;
    }
    apiFetch<{ user: User }>("/auth/me", token)
      .then((data) => {
        setUser(data.user);
        localStorage.setItem("user", JSON.stringify(data.user));
        if (view === "login") go(roleHome(data.user.role), true);
      })
      .catch(logout)
      .finally(() => setChecking(false));
  }, [token]);

  useEffect(() => {
    if (!token || !user) return;
    const next = io(SOCKET_URL, { auth: { token } });
    setSocket(next);
    return () => next.disconnect();
  }, [token, user]);

  useEffect(() => {
    if (user && view !== "login" && !canAccess(user.role, view)) go(roleHome(user.role), true);
  }, [user, view]);

  if (checking) return <FullScreenLoading label="Opening service" />;
  if (!token || !user) return <AccessScreen initialView={view} onLogin={onLogin} />;

  const nav = [
    { view: "waiter" as View, label: "Floor", icon: <ClipboardList />, roles: ["WAITER", "ADMIN", "MANAGER"] },
    { view: "kitchen" as View, label: "Kitchen", icon: <ChefHat />, roles: ["CHEF", "ADMIN", "MANAGER"] },
    { view: "cashier" as View, label: "Pay", icon: <CreditCard />, roles: ["CASHIER", "ADMIN", "MANAGER"] },
    { view: "admin" as View, label: "Setup", icon: <Settings />, roles: ["ADMIN", "MANAGER"] },
  ].filter((item) => item.roles.includes(user.role));

  return (
    <div className="shell">
      <aside className="side-nav">
        <button className="brand-mark" onClick={() => go(roleHome(user.role))}>
          <ChefHat />
          <span>OrderFlow</span>
        </button>
        <nav>
          {nav.map((item) => (
            <button key={item.view} className={view === item.view ? "active" : ""} onClick={() => go(item.view)}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="signed-in">
          <span>{user.name}</span>
          <button title="Logout" onClick={logout}>
            <LogOut />
          </button>
        </div>
      </aside>
      <main className="workspace">
        {notice && (
          <div className="toast">
            <Bell size={18} />
            {notice}
          </div>
        )}
        {view === "waiter" && <WaiterService token={token} socket={socket} notify={notify} />}
        {view === "kitchen" && <KitchenDisplay token={token} socket={socket} notify={notify} />}
        {view === "cashier" && <CashierDesk token={token} socket={socket} notify={notify} />}
        {view === "admin" && <AdminSetup token={token} notify={notify} />}
      </main>
    </div>
  );
}

function AccessScreen({ initialView, onLogin }: { initialView: View; onLogin: (token: string, user: User) => void }) {
  const [staff, setStaff] = useState<User[]>([]);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<{ users: User[] }>("/auth/staff")
      .then((data) => setStaff(data.users))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load staff"))
      .finally(() => setLoading(false));
  }, []);

  async function adminLogin(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setWorkingId("admin");
    try {
      const data = await apiFetch<{ token: string; user: User }>("/auth/admin-login", "", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      onLogin(data.token, data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Admin login failed");
    } finally {
      setWorkingId("");
    }
  }

  async function staffLogin(person: User) {
    setError("");
    setWorkingId(person.id);
    try {
      const data = await apiFetch<{ token: string; user: User }>("/auth/staff-login", "", {
        method: "POST",
        body: JSON.stringify({ userId: person.id, role: person.role }),
      });
      onLogin(data.token, data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Access failed");
    } finally {
      setWorkingId("");
    }
  }

  const groups = [
    { role: "WAITER" as Role, title: "Waiters", icon: <ClipboardList /> },
    { role: "CHEF" as Role, title: "Kitchen", icon: <ChefHat /> },
    { role: "CASHIER" as Role, title: "Cashiers", icon: <Banknote /> },
  ];
  const focusedRole = initialView === "waiter" ? "WAITER" : initialView === "kitchen" ? "CHEF" : initialView === "cashier" ? "CASHIER" : "";
  const visibleGroups = focusedRole ? groups.filter((group) => group.role === focusedRole) : groups;

  return (
    <main className="access-page">
      <section className="access-panel">
        <div className="access-hero">
          <div className="brand-line">
            <ChefHat />
            <span>OrderFlow</span>
          </div>
          <h1>Start service</h1>
          <p>Staff tap their name. Admin sets up tables, people, and the menu.</p>
        </div>
        <div className="access-content">
          {loading && <InlineLoading label="Loading staff" />}
          {error && <div className="error-strip">{error}</div>}
          <div className="role-board">
            {visibleGroups.map((group) => {
              const people = staff.filter((person) => person.role === group.role);
              return (
                <section className="role-group" key={group.role}>
                  <div className="section-title">
                    {group.icon}
                    <h2>{group.title}</h2>
                  </div>
                  <div className="person-grid">
                    {people.map((person) => (
                      <button className="person-card" key={person.id} onClick={() => staffLogin(person)} disabled={!!workingId}>
                        <span className={`initial ${person.role.toLowerCase()}`}>{workingId === person.id ? <Loader2 /> : person.name[0]}</span>
                        <strong>{person.name}</strong>
                      </button>
                    ))}
                    {!loading && people.length === 0 && <div className="empty-mini">Admin has not added {group.title.toLowerCase()} yet.</div>}
                  </div>
                </section>
              );
            })}
          </div>
          <form className="admin-door" onSubmit={adminLogin}>
            <div className="section-title">
              <DoorOpen />
              <h2>Admin</h2>
            </div>
            <input type="password" placeholder="Admin password" value={password} onChange={(event) => setPassword(event.target.value)} />
            <button className="solid" disabled={workingId === "admin" || !password}>
              {workingId === "admin" ? <Loader2 /> : <Settings />}
              Open setup
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

function WaiterService({ token, socket, notify }: { token: string; socket: Socket | null; notify: (value: string, audible?: boolean) => void }) {
  const [tables, setTables] = useState<Table[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedTableId, setSelectedTableId] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<Record<string, CartRow>>({});
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [servingId, setServingId] = useState("");
  const [orderType, setOrderType] = useState<"DINE_IN" | "TAKEAWAY">("DINE_IN");
  const [customerName, setCustomerName] = useState("");

  const selectedTable = tables.find((table) => table.id === selectedTableId);
  const cartRows = Object.values(cart);
  const total = cartRows.reduce((sum, row) => sum + row.item.price * row.quantity, 0);
  const readyOrders = orders.filter((order) => order.status === "READY");
  const tableOrders = (selectedTable && orderType === "DINE_IN") ? sortNewest(orders.filter((order) => order.table?.id === selectedTable.id && order.status !== "PAID")) : [];
  const tableOpenTotal = tableOrders.reduce((sum, order) => sum + order.totalPrice, 0);
  const isAddOnTicket = tableOrders.length > 0;

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      const categoryMatch = categoryId === "all" || item.categoryId === categoryId;
      const searchMatch = !term || item.name.toLowerCase().includes(term) || item.description?.toLowerCase().includes(term);
      return categoryMatch && searchMatch;
    });
  }, [items, categoryId, search]);

  async function load() {
    const data = await apiFetch<{ tables: Table[]; categories: Category[]; items: MenuItem[]; orders: Order[] }>("/bootstrap/waiter", token);
    setTables(data.tables);
    setCategories(data.categories);
    setItems(data.items);
    setOrders(sortNewest(data.orders));
    setSelectedTableId((current) => current || data.tables[0]?.id || "");
    setLoading(false);
  }

  useEffect(() => {
    load().catch((err) => {
      setLoading(false);
      notify(err instanceof Error ? err.message : "Could not load floor");
    });
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onOrder = (order: Order) => {
      setOrders((current) => upsertOrder(current, order));
      if (order.status === "READY") notify(`Table ${order.table.tableNumber} is ready`);
    };
    const onTable = (payload: Table | { setup?: boolean; tables?: Table[] }) => {
      if ("setup" in payload && payload.tables) setTables(payload.tables);
      if ("id" in payload) setTables((current) => current.map((table) => (table.id === payload.id ? { ...table, ...payload } : table)));
    };
    const onFailed = ({ orderId, message }: { orderId: string; message: string }) => {
      setOrders((current) => current.filter((order) => order.id !== orderId));
      notify(message);
    };
    socket.on("order:created", onOrder);
    socket.on("order:status_changed", onOrder);
    socket.on("payment:completed", onOrder);
    socket.on("table:status_changed", onTable);
    socket.on("order:failed", onFailed);
    return () => {
      socket.off("order:created", onOrder);
      socket.off("order:status_changed", onOrder);
      socket.off("payment:completed", onOrder);
      socket.off("table:status_changed", onTable);
      socket.off("order:failed", onFailed);
    };
  }, [socket]);

  function addItem(item: MenuItem) {
    setCart((current) => ({
      ...current,
      [item.id]: { item, quantity: (current[item.id]?.quantity ?? 0) + 1, note: current[item.id]?.note ?? "" },
    }));
  }

  function changeQuantity(row: CartRow, amount: number) {
    setCart((current) => {
      const next = { ...current };
      const quantity = row.quantity + amount;
      if (quantity <= 0) delete next[row.item.id];
      else next[row.item.id] = { ...row, quantity };
      return next;
    });
  }

  async function sendOrder() {
    if (orderType === "DINE_IN" && !selectedTable) return;
    if (orderType === "TAKEAWAY" && !customerName.trim()) {
      notify("Please enter a customer name");
      return;
    }
    if (cartRows.length === 0 || sending) return;
    setSending(true);
    try {
      const payload = orderType === "DINE_IN"
        ? { orderType: "DINE_IN", tableId: selectedTable!.id, tableNumber: selectedTable!.tableNumber }
        : { orderType: "TAKEAWAY", customerName: customerName.trim() };

      const data = await apiFetch<{ order: Order }>("/orders", token, {
        method: "POST",
        timeoutMs: 5000,
        body: JSON.stringify({
          ...payload,
          items: cartRows.map((row) => ({
            menuItemId: row.item.id,
            menuItemName: row.item.name,
            unitPrice: row.item.price,
            quantity: row.quantity,
            note: row.note || undefined,
          })),
        }),
      });
      setOrders((current) => upsertOrder(current, data.order));
      setCart({});
      if (orderType === "TAKEAWAY") setCustomerName("");
      notify(`Sent to kitchen: ${orderType === "TAKEAWAY" ? customerName : `table ${data.order.table?.tableNumber}`}`);
    } catch (err) {
      notify(err instanceof Error ? `Order not sent: ${err.message}` : "Order not sent");
    } finally {
      setSending(false);
    }
  }

  async function handleTableTap(table: Table, readyOrder?: Order) {
    if (!readyOrder) {
      setSelectedTableId(table.id);
      return;
    }

    if (servingId) return;
    setSelectedTableId(table.id);
    setServingId(readyOrder.id);
    const previous = readyOrder;
    setOrders((current) =>
      current.map((order) => (order.id === readyOrder.id ? { ...order, status: "SERVED", updatedAt: new Date().toISOString() } : order)),
    );

    try {
      const data = await apiFetch<{ order: Order }>(`/orders/${readyOrder.id}/status`, token, {
        method: "PATCH",
        timeoutMs: 15000,
        body: JSON.stringify({ status: "SERVED", note: "Waiter delivered food to table" }),
      });
      setOrders((current) => upsertOrder(current, data.order));
      notify(`Delivered to table ${table.tableNumber}`, false);
    } catch (err) {
      setOrders((current) => current.map((order) => (order.id === previous.id ? previous : order)));
      notify(err instanceof Error ? err.message : "Could not mark delivered");
      setServingId("");
    }
  }

  async function handleTakeawayTook(order: Order) {
    if (servingId || order.status !== "READY") return;
    setServingId(order.id);
    const previous = order;
    setOrders((current) =>
      current.map((row) => (row.id === order.id ? { ...row, status: "SERVED", updatedAt: new Date().toISOString() } : row)),
    );

    try {
      const data = await apiFetch<{ order: Order }>(`/orders/${order.id}/status`, token, {
        method: "PATCH",
        timeoutMs: 15000,
        body: JSON.stringify({ status: "SERVED", note: "Takeaway handed to customer" }),
      });
      setOrders((current) => upsertOrder(current, data.order));
      notify(`Handed to ${order.customerName}`, false);
    } catch (err) {
      setOrders((current) => current.map((row) => (row.id === previous.id ? previous : row)));
      notify(err instanceof Error ? err.message : "Could not mark as taken");
    } finally {
      setServingId("");
    }
  }

  return (
    <section className="service-grid">
      <div className="floor-column">
        <ScreenHeader eyebrow="Waiter" title="Floor service" subtitle="Pick a table, build the ticket, send once." />
        {loading && <InlineLoading label="Loading tables and menu" />}
        {readyOrders.length > 0 && (
          <div className="ready-ribbon">
            <Bell />
            {readyOrders.length} order{readyOrders.length > 1 ? "s" : ""} ready for pickup
          </div>
        )}
        <div className="order-type-toggle">
          <button className={orderType === "DINE_IN" ? "selected" : ""} onClick={() => setOrderType("DINE_IN")}>Dine-in</button>
          <button className={orderType === "TAKEAWAY" ? "selected" : ""} onClick={() => setOrderType("TAKEAWAY")}>Takeaway</button>
        </div>
        {orderType === "DINE_IN" ? (
          <div className="table-map">
            {tables.map((table) => {
              const tableActiveOrders = orders.filter((row) => row.table?.id === table.id && row.status !== "PAID");
              const readyOrder = tableActiveOrders.find((row) => row.status === "READY");
              const order = readyOrder ?? tableActiveOrders[0];
              return (
                <button
                  className={`table-seat ${selectedTableId === table.id ? "selected" : ""} ${table.status.toLowerCase()} ${order?.status.toLowerCase() ?? ""} ${servingId === readyOrder?.id ? "serving" : ""}`}
                  key={table.id}
                  onClick={() => handleTableTap(table, readyOrder)}
                >
                  <strong>{table.tableNumber}</strong>
                  <span>
                    {servingId === readyOrder?.id
                      ? "Serving..."
                      : readyOrder
                        ? "Tap when served"
                        : order
                          ? order.status.replaceAll("_", " ")
                          : "Open"}
                  </span>
                </button>
              );
            })}
            {!loading && tables.length === 0 && <EmptyState icon={<Grid3X3 />} title="No tables yet" text="Admin needs to set the table count before waiters can order." />}
          </div>
        ) : (
          <div className="takeaway-section">
            <div className="takeaway-input">
              <input 
                placeholder="Customer Name (e.g. John Doe)" 
                value={customerName} 
                onChange={(e) => setCustomerName(e.target.value)} 
              />
            </div>
            <div className="takeaway-list">
              {orders.filter(o => o.orderType === "TAKEAWAY" && o.status !== "PAID").map(order => (
                <div className={`takeaway-card ${order.status.toLowerCase()}`} key={order.id}>
                  <div className="takeaway-info">
                    <strong>{order.customerName || "No name"}</strong>
                    <span>{order.status === "READY" ? "Ready for pickup" : order.status.replaceAll("_", " ")}</span>
                  </div>
                  <button 
                    className={order.status === "READY" ? "solid" : ""} 
                    disabled={servingId === order.id || order.status !== "READY"}
                    onClick={() => handleTakeawayTook(order)}
                  >
                    {servingId === order.id ? <Loader2 /> : <Check />}
                    {order.status === "SERVED" ? "Taken" : order.status === "READY" ? "Took" : "Pending"}
                  </button>
                </div>
              ))}
              {!loading && orders.filter(o => o.orderType === "TAKEAWAY" && o.status !== "PAID").length === 0 && (
                <EmptyState icon={<Sparkles />} title="No active takeaways" text="Pending and ready takeaway orders will appear here." />
              )}
            </div>
          </div>
        )}
        <div className="menu-toolbar">
          <div className="search-box">
            <Search size={18} />
            <input placeholder="Search menu" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="category-tabs">
            <button className={categoryId === "all" ? "selected" : ""} onClick={() => setCategoryId("all")}>All</button>
            {categories.map((category) => (
              <button key={category.id} className={categoryId === category.id ? "selected" : ""} onClick={() => setCategoryId(category.id)}>
                {category.name}
              </button>
            ))}
          </div>
        </div>
        <div className="menu-board">
          {filteredItems.map((item) => (
            <button key={item.id} className="dish-card" onClick={() => addItem(item)}>
              <span>{item.category.name}</span>
              <strong>{item.name}</strong>
              {item.description && <small>{item.description}</small>}
              <b>{money(item.price)}</b>
            </button>
          ))}
          {!loading && items.length === 0 && <EmptyState icon={<Utensils />} title="No menu yet" text="Admin needs to add categories and items." />}
        </div>
      </div>
      <aside className="ticket-panel">
        <div className="ticket-head">
          <div>
            <span>{isAddOnTicket ? "Add-on ticket" : "Current ticket"}</span>
            <strong>{orderType === "DINE_IN" ? (selectedTable ? `Table ${selectedTable.tableNumber}` : "No table") : `Takeaway: ${customerName || "No name"}`}</strong>
          </div>
          {isAddOnTicket && <b>{money(tableOpenTotal)} open</b>}
        </div>
        <div className="ticket-lines">
          {cartRows.map((row) => (
            <div className="ticket-line" key={row.item.id}>
              <div>
                <strong>{row.item.name}</strong>
                <input
                  placeholder="Kitchen note"
                  value={row.note}
                  onChange={(event) => setCart((current) => ({ ...current, [row.item.id]: { ...row, note: event.target.value } }))}
                />
              </div>
              <div className="quantity-control">
                <button onClick={() => changeQuantity(row, -1)}><Minus /></button>
                <span>{row.quantity}</span>
                <button onClick={() => changeQuantity(row, 1)}><Plus /></button>
              </div>
            </div>
          ))}
          {cartRows.length === 0 && <div className="ticket-empty">Tap menu items to build this ticket.</div>}
        </div>
        <div className="ticket-total">
          <span>Total</span>
          <strong>{money(total)}</strong>
        </div>
        <button className="send-button" onClick={sendOrder} disabled={(orderType === "DINE_IN" && !selectedTable) || (orderType === "TAKEAWAY" && !customerName.trim()) || cartRows.length === 0 || sending}>
          {sending ? <Loader2 /> : <ChefHat />}
          {sending ? "Sending" : isAddOnTicket ? "Send add-on" : "Send to kitchen"}
        </button>
        <div className="table-activity">
          <div className="activity-head">
            <h3>Open orders</h3>
            {tableOrders.length > 0 && <b>{tableOrders.length}</b>}
          </div>
          {tableOrders.map((order, index) => (
            <details className="order-dropdown" key={order.id} open={index === 0}>
              <summary>
                <span>
                  <strong>{statusLabel(order.status)}</strong>
                  <small>{order.items.length} item{order.items.length === 1 ? "" : "s"}</small>
                </span>
                <b>{money(order.totalPrice)}</b>
              </summary>
              <div className="dropdown-lines">
                {order.items.map((item) => (
                  <div key={item.id}>
                    <span>{item.quantity}x {item.menuItemName}</span>
                    <b>{money(item.lineTotal)}</b>
                    {item.note && <em>{item.note}</em>}
                  </div>
                ))}
              </div>
            </details>
          ))}
          {tableOrders.length === 0 && <p>No open orders for this table.</p>}
        </div>
      </aside>
    </section>
  );
}

function KitchenDisplay({ token, socket, notify }: { token: string; socket: Socket | null; notify: (value: string, audible?: boolean) => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  useClock(15000);

  async function load() {
    const data = await apiFetch<{ orders: Order[] }>("/kitchen/orders", token);
    setOrders(sortOldest(data.orders));
    setLoading(false);
  }

  useEffect(() => {
    load().catch((err) => {
      setLoading(false);
      notify(err instanceof Error ? err.message : "Could not load kitchen");
    });
  }, []);

  useEffect(() => {
    if (!socket) return;
    const sync = (order: Order) => {
      setOrders((current) => {
        const without = current.filter((row) => row.id !== order.id);
        return activeKitchenStatuses.includes(order.status) ? sortOldest([...without, order]) : without;
      });
    };
    const created = (order: Order) => {
      sync(order);
      notify(`New order: ${order.orderType === "TAKEAWAY" ? "Takeaway" : `Table ${order.table?.tableNumber}`}`);
    };
    const failed = ({ orderId, message }: { orderId: string; message: string }) => {
      setOrders((current) => current.filter((order) => order.id !== orderId));
      notify(message);
    };
    socket.on("order:created", created);
    socket.on("order:status_changed", sync);
    socket.on("order:failed", failed);
    return () => {
      socket.off("order:created", created);
      socket.off("order:status_changed", sync);
      socket.off("order:failed", failed);
    };
  }, [socket]);

  async function ready(order: Order) {
    if (workingId) return;
    setWorkingId(order.id);
    try {
      await apiFetch<{ order: Order }>(`/orders/${order.id}/status`, token, {
        method: "PATCH",
        timeoutMs: 15000,
        body: JSON.stringify({ status: "READY", note: "Kitchen marked ready" }),
      });
      setOrders((current) => current.filter((row) => row.id !== order.id));
      notify(`Waiter notified: ${order.orderType === "TAKEAWAY" ? "Takeaway" : `Table ${order.table?.tableNumber}`}`, false);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not mark ready");
    } finally {
      setWorkingId("");
    }
  }

  return (
    <section className="kds-screen">
      <ScreenHeader eyebrow="Kitchen" title="Live queue" subtitle="Cook oldest first. One tap tells the waiter it is ready." />
      {loading && <InlineLoading label="Loading active tickets" dark />}
      <div className="kds-stats">
        <Metric label="In queue" value={orders.length} />
        <Metric label="Oldest wait" value={orders[0] ? `${minutesWaiting(orders[0])}m` : "0m"} />
      </div>
      <div className="kds-grid">
        {orders.map((order) => {
          const age = minutesWaiting(order);
          return (
            <article className={`kds-ticket ${age >= 15 ? "late" : age >= 8 ? "warn" : ""} ${workingId === order.id ? "working" : ""}`} key={order.id}>
              <header>
                <div>
                  <span>{order.orderType === "TAKEAWAY" ? "Takeaway" : "Table"}</span>
                  <strong>{order.orderType === "TAKEAWAY" ? order.customerName || "?" : order.table?.tableNumber}</strong>
                </div>
                <b>{age}m</b>
              </header>
              <div className="kds-items">
                {order.items.map((item) => (
                  <div className="kds-item" key={item.id}>
                    <strong>{item.quantity}</strong>
                    <span>{item.menuItemName}</span>
                    {item.note && <em>{item.note}</em>}
                  </div>
                ))}
              </div>
              <button className="ready-button" onClick={() => ready(order)} disabled={workingId === order.id}>
                {workingId === order.id ? <Loader2 /> : <Check />}
                {workingId === order.id ? "Notifying waiter..." : "Ready"}
              </button>
            </article>
          );
        })}
        {!loading && orders.length === 0 && <EmptyState dark icon={<Sparkles />} title="Kitchen clear" text="New orders will appear here instantly." />}
      </div>
    </section>
  );
}

function CashierDesk({ token, socket, notify }: { token: string; socket: Socket | null; notify: (value: string, audible?: boolean) => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [payingId, setPayingId] = useState("");

  async function load() {
    const data = await apiFetch<{ orders: Order[] }>("/orders", token);
    setOrders(sortNewest(data.orders.filter((order) => billStatuses.includes(order.status))));
    setLoading(false);
  }

  useEffect(() => {
    load().catch((err) => {
      setLoading(false);
      notify(err instanceof Error ? err.message : "Could not load bills");
    });
  }, []);

  useEffect(() => {
    if (!socket) return;
    const sync = (order: Order) => {
      setOrders((current) => {
        const without = current.filter((row) => row.id !== order.id);
        return billStatuses.includes(order.status) ? sortNewest([order, ...without]) : without;
      });
    };
    socket.on("order:created", sync);
    socket.on("order:status_changed", sync);
    socket.on("payment:completed", sync);
    return () => {
      socket.off("order:created", sync);
      socket.off("order:status_changed", sync);
      socket.off("payment:completed", sync);
    };
  }, [socket]);

  async function pay(order: Order) {
    setPayingId(order.id);
    try {
      await apiFetch("/payments", token, {
        method: "POST",
        body: JSON.stringify({ orderId: order.id, method: "CASH" }),
      });
      setOrders((current) => current.filter((row) => row.id !== order.id));
      notify(`Payment recorded for ${order.orderType === "TAKEAWAY" ? "Takeaway" : `Table ${order.table?.tableNumber}`}`, false);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not record payment");
    } finally {
      setPayingId("");
    }
  }

  return (
    <section>
      <ScreenHeader eyebrow="Cashier" title="Close checks" subtitle="Ready tables appear here for quick payment." />
      {loading && <InlineLoading label="Loading checks" />}
      <div className="bill-list">
        {orders.map((order) => (
          <article className="bill-card" key={order.id}>
            <div className="bill-table">
              <span>{order.orderType === "TAKEAWAY" ? "Takeaway" : "Table"}</span>
              <strong>{order.orderType === "TAKEAWAY" ? order.customerName || "?" : order.table?.tableNumber}</strong>
            </div>
            <div>
              <strong>{order.items.map((item) => `${item.quantity} ${item.menuItemName}`).join(", ")}</strong>
              <p>{order.status.toLowerCase()}</p>
            </div>
            <b>{money(order.totalPrice)}</b>
            <button onClick={() => pay(order)} disabled={!!payingId}>
              {payingId === order.id ? <Loader2 /> : <CreditCard />}
              Paid
            </button>
          </article>
        ))}
        {!loading && orders.length === 0 && <EmptyState icon={<CreditCard />} title="No open checks" text="Ready orders will land here." />}
      </div>
    </section>
  );
}

function AdminSetup({ token, notify }: { token: string; notify: (value: string, audible?: boolean) => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notificationTopics, setNotificationTopics] = useState<NotificationTopics | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [testingPush, setTestingPush] = useState("");
  const [staffName, setStaffName] = useState("");
  const [staffRole, setStaffRole] = useState<Role>("WAITER");
  const [staffPassword, setStaffPassword] = useState("");
  const [tableCount, setTableCount] = useState("");
  const [tableSeats, setTableSeats] = useState("4");
  const [categoryName, setCategoryName] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [itemCategoryId, setItemCategoryId] = useState("");

  async function load() {
    const data = await apiFetch<{
      summary: Summary;
      notifications: NotificationTopics;
      users: User[];
      tables: Table[];
      categories: Category[];
      items: MenuItem[];
    }>("/bootstrap/admin", token);
    setSummary(data.summary);
    setNotificationTopics(data.notifications);
    setUsers(data.users);
    setTables(data.tables);
    setTableCount(String(data.tables.length || ""));
    setCategories(data.categories);
    setItems(data.items);
    setItemCategoryId(data.categories[0]?.id ?? "");
    setLoading(false);
  }

  useEffect(() => {
    load().catch((err) => {
      setLoading(false);
      notify(err instanceof Error ? err.message : "Could not load setup");
    });
  }, []);

  const staff = users.filter((user) => user.role !== "ADMIN");
  const checklist = [
    { label: "Staff", done: staff.length > 0, value: staff.length },
    { label: "Tables", done: tables.length > 0, value: tables.length },
    { label: "Categories", done: categories.length > 0, value: categories.length },
    { label: "Menu items", done: items.length > 0, value: items.length },
  ];

  async function addStaff(event: React.FormEvent) {
    event.preventDefault();
    if (!staffName.trim()) return;
    const needsPassword = ["ADMIN", "MANAGER"].includes(staffRole);
    if (needsPassword && staffPassword.length < 6) {
      notify("Admin and manager access needs a password");
      return;
    }
    setSaving("staff");
    try {
      const data = await apiFetch<{ user: User }>("/users", token, {
        method: "POST",
        body: JSON.stringify({ name: staffName.trim(), role: staffRole, password: needsPassword ? staffPassword : undefined }),
      });
      setUsers((current) => [...current, data.user].sort((a, b) => a.name.localeCompare(b.name)));
      setStaffName("");
      setStaffPassword("");
      notify("Staff access added", false);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not add staff");
    } finally {
      setSaving("");
    }
  }

  async function saveTables(event: React.FormEvent) {
    event.preventDefault();
    const count = Number(tableCount);
    const seats = Number(tableSeats);
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(seats) || seats <= 0) return;
    setSaving("tables");
    try {
      const data = await apiFetch<{ tables: Table[] }>("/tables/setup", token, {
        method: "PUT",
        body: JSON.stringify({ count, seats }),
      });
      setTables(data.tables);
      notify("Tables saved", false);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not save tables");
    } finally {
      setSaving("");
    }
  }

  async function addCategory(event: React.FormEvent) {
    event.preventDefault();
    if (!categoryName.trim()) return;
    setSaving("category");
    try {
      const data = await apiFetch<{ category: Category }>("/menu/categories", token, {
        method: "POST",
        body: JSON.stringify({ name: categoryName.trim(), sortOrder: categories.length + 1 }),
      });
      setCategories((current) => [...current, data.category]);
      setItemCategoryId(data.category.id);
      setCategoryName("");
      notify("Category added", false);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not add category");
    } finally {
      setSaving("");
    }
  }

  async function addItem(event: React.FormEvent) {
    event.preventDefault();
    if (!itemName.trim() || !itemCategoryId || Number(itemPrice) <= 0) return;
    setSaving("item");
    try {
      const data = await apiFetch<{ item: MenuItem }>("/menu/items", token, {
        method: "POST",
        body: JSON.stringify({
          name: itemName.trim(),
          description: itemDescription.trim() || undefined,
          price: Number(itemPrice),
          categoryId: itemCategoryId,
          available: true,
        }),
      });
      setItems((current) => [...current, data.item].sort((a, b) => a.name.localeCompare(b.name)));
      setItemName("");
      setItemDescription("");
      setItemPrice("");
      notify("Menu item added", false);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not add item");
    } finally {
      setSaving("");
    }
  }

  async function toggleItem(item: MenuItem) {
    const data = await apiFetch<{ item: MenuItem }>(`/menu/items/${item.id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ available: !item.available }),
    });
    setItems((current) => current.map((row) => (row.id === item.id ? data.item : row)));
  }

  async function testPush(target: "kitchen" | "waiter" | "cashier") {
    setTestingPush(target);
    try {
      await apiFetch(`/notifications/test`, token, {
        method: "POST",
        body: JSON.stringify({ target }),
      });
      notify(`Test push sent to ${target}`, false);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Push test failed");
    } finally {
      setTestingPush("");
    }
  }

  function topicUrl(topic?: string) {
    if (!notificationTopics || !topic) return "#";
    return `${notificationTopics.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(topic)}`;
  }

  return (
    <section>
      <ScreenHeader eyebrow="Admin" title="Restaurant setup" subtitle="Everything the floor uses starts here." />
      {loading && <InlineLoading label="Loading setup" />}
      <div className="admin-overview">
        <Metric label="Sales today" value={money(summary?.todayRevenue ?? 0)} />
        <Metric label="Paid orders" value={summary?.paidOrders ?? 0} />
        <Metric label="Active orders" value={summary?.activeOrders ?? 0} />
        <article className="notification-card">
          <div className="section-title"><Volume2 /><h2>Phone push</h2></div>
          <p>Subscribe staff phones in ntfy, then send a test push before service starts.</p>
          <div className="topic-list">
            <span>Kitchen</span>
            <b>{notificationTopics?.topics.kitchen ?? "Loading"}</b>
            <a href={topicUrl(notificationTopics?.topics.kitchen)} target="_blank" rel="noreferrer">Open</a>
            <button onClick={() => testPush("kitchen")} disabled={testingPush === "kitchen"}>
              {testingPush === "kitchen" ? "Sending" : "Test"}
            </button>
            <span>Waiter</span>
            <b>{notificationTopics?.topics.waiter ?? "Loading"}</b>
            <a href={topicUrl(notificationTopics?.topics.waiter)} target="_blank" rel="noreferrer">Open</a>
            <button onClick={() => testPush("waiter")} disabled={testingPush === "waiter"}>
              {testingPush === "waiter" ? "Sending" : "Test"}
            </button>
          </div>
        </article>
      </div>
      <div className="setup-checklist">
        {checklist.map((item) => (
          <article className={item.done ? "done" : ""} key={item.label}>
            <span>{item.done ? <Check /> : <Settings />}</span>
            <strong>{item.label}</strong>
            <b>{item.value}</b>
          </article>
        ))}
      </div>
      <div className="setup-layout">
        <div className="setup-forms">
          <form className="setup-card" onSubmit={addStaff}>
            <div className="section-title"><UserRound /><h2>Staff access</h2></div>
            <input placeholder="Name" value={staffName} onChange={(event) => setStaffName(event.target.value)} />
            <select value={staffRole} onChange={(event) => setStaffRole(event.target.value as Role)}>
              <option value="WAITER">Waiter</option>
              <option value="CHEF">Chef</option>
              <option value="CASHIER">Cashier</option>
              <option value="MANAGER">Manager</option>
              <option value="ADMIN">Admin</option>
            </select>
            {["ADMIN", "MANAGER"].includes(staffRole) && (
              <input type="password" placeholder="Password" value={staffPassword} onChange={(event) => setStaffPassword(event.target.value)} />
            )}
            <button className="solid" disabled={saving === "staff"}>{saving === "staff" ? <Loader2 /> : <Plus />} Add staff</button>
          </form>
          <form className="setup-card" onSubmit={saveTables}>
            <div className="section-title"><Grid3X3 /><h2>Tables</h2></div>
            <div className="two-inputs">
              <input placeholder="Tables" inputMode="numeric" value={tableCount} onChange={(event) => setTableCount(event.target.value)} />
              <input placeholder="Seats" inputMode="numeric" value={tableSeats} onChange={(event) => setTableSeats(event.target.value)} />
            </div>
            <button className="solid" disabled={saving === "tables"}>{saving === "tables" ? <Loader2 /> : <Check />} Save tables</button>
          </form>
          <form className="setup-card" onSubmit={addCategory}>
            <div className="section-title"><ClipboardList /><h2>Category</h2></div>
            <input placeholder="Breakfast, Lunch, Drinks..." value={categoryName} onChange={(event) => setCategoryName(event.target.value)} />
            <button className="solid" disabled={saving === "category"}>{saving === "category" ? <Loader2 /> : <Plus />} Add category</button>
          </form>
          <form className="setup-card wide" onSubmit={addItem}>
            <div className="section-title"><Utensils /><h2>Menu item</h2></div>
            <input placeholder="Item name" value={itemName} onChange={(event) => setItemName(event.target.value)} />
            <input placeholder="Short description" value={itemDescription} onChange={(event) => setItemDescription(event.target.value)} />
            <div className="two-inputs">
              <input placeholder="Price" inputMode="decimal" value={itemPrice} onChange={(event) => setItemPrice(event.target.value)} />
              <select value={itemCategoryId} onChange={(event) => setItemCategoryId(event.target.value)}>
                <option value="">Category</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </div>
            <button className="solid" disabled={saving === "item"}>{saving === "item" ? <Loader2 /> : <Plus />} Add item</button>
          </form>
        </div>
        <aside className="setup-lists">
          <ListPanel title="Staff">
            {staff.map((person) => (
              <div className="compact-row" key={person.id}>
                <span>{person.name}</span>
                <b>{person.role.toLowerCase()}</b>
              </div>
            ))}
            {staff.length === 0 && <p>No staff yet.</p>}
          </ListPanel>
          <ListPanel title="Menu">
            {items.map((item) => (
              <div className="compact-row" key={item.id}>
                <span>{item.name}</span>
                <button onClick={() => toggleItem(item)}>{item.available ? "On" : "Off"}</button>
              </div>
            ))}
            {items.length === 0 && <p>No menu items yet.</p>}
          </ListPanel>
        </aside>
      </div>
    </section>
  );
}

function ScreenHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <header className="screen-header">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  );
}

function InlineLoading({ label, dark = false }: { label: string; dark?: boolean }) {
  return (
    <div className={`inline-loading ${dark ? "dark" : ""}`}>
      <Loader2 />
      {label}
    </div>
  );
}

function FullScreenLoading({ label }: { label: string }) {
  return (
    <main className="full-loading">
      <Loader2 />
      {label}
    </main>
  );
}

function EmptyState({ icon, title, text, dark = false }: { icon: React.ReactNode; title: string; text: string; dark?: boolean }) {
  return (
    <div className={`empty-state ${dark ? "dark" : ""}`}>
      {icon}
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ListPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="list-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
