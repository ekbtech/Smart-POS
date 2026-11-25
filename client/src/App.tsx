import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpDown, ArrowUpRight, Boxes, CalendarDays, Camera, CameraOff, ChevronDown, CircleDollarSign,
  Command, LayoutDashboard, LogOut, Menu, PackagePlus, Plus, Search, ShieldCheck,
  ShoppingBasket, ShoppingCart, TrendingUp, X, Users, Truck, Banknote, ReceiptText, RotateCcw, Download,
  Pause, Printer, QrCode, RefreshCw, ScanBarcode, Smartphone, Trash2, Upload,
} from "lucide-react";
import type { BrowserMultiFormatReader } from "@zxing/browser";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useEffect } from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { KeyboardEvent, ReactNode } from "react";
import { z } from "zod";
import {
  api, getErrorMessage, type BranchReport, type DashboardSummary, type Product, type User,
} from "./api";
import { createUuid } from "./uuid";
import { listOfflineSales, removeOfflineSale, saveOfflineSale, updateOfflineSale, type OfflineSaleRecord } from "./offline";

const ReportsCharts = lazy(() => import("./ReportsCharts"));
const DashboardSalesChart = lazy(() => import("./DashboardSalesChart"));
const CashierMonitoringPage = lazy(() => import("./CashierMonitoringPage"));
const LiveCashierSummary = lazy(() => import("./CashierMonitoringPage")
  .then((module) => ({ default: module.LiveCashierSummary })));

const money = (value: string | number) => new Intl.NumberFormat("en-KE", {
  style: "currency", currency: "KES", maximumFractionDigits: 2,
}).format(Number(value));
const cents = (value: string) => Math.round(Number(value) * 100);
const fromCents = (value: number) => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
const greeting = new Intl.DateTimeFormat("en-KE", { weekday: "long", month: "long", day: "numeric" }).format(new Date());
const timeGreeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 17 ? "Good afternoon" : "Good evening";
const dateInputValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
type PosCartLine = { lineId: number; product: Product; quantity: number };
type SaleReceipt = {
  sale: {
    id: number; receiptNumber: string; subtotal: string; discount: string; tax: string;
    total: string; status: string; createdAt: string; cashier: string; customer: string | null;
    branch: string; cashReceived: string | null; changeDue: string;
  };
  business: { name: string; phone: string; address: string; logoUrl: string | null };
  items: Array<{
    id: number; productId?: number; sku: string; name: string; quantity: string;
    refunded?: string; unitPrice: string; taxRate?: string; lineTotal: string;
  }>;
  payments: Array<{ method: string; amount: string; status: string; reference: string | null }>;
};
type BankTransferVerification = {
  id: number; amount: string; status: "pending" | "verified" | "rejected" | "used";
};
type MpesaPayment = {
  id: string;
  status: "created" | "requesting" | "pending" | "verifying" | "succeeded" | "failed" | "unknown" | "cancelled";
  amount: string;
  description: string;
  saleId: number | null;
  receiptNumber: string | null;
  error: string | null;
};
const aggregateCartItems = (items: PosCartLine[]) => {
  const quantities = new Map<number, number>();
  for (const item of items) quantities.set(item.product.id, (quantities.get(item.product.id) ?? 0) + item.quantity);
  return Array.from(quantities, ([productId, quantity]) => ({ productId, quantity: String(quantity) }));
};
const unitForPackageSize = (value: string): Product["unit"] | undefined => {
  const match = value.match(/(?:^|\s)\d+(?:[.,]\d+)?\s*(kg|g|ml|l|litre|liter)\b/i);
  const unit = match?.[1]?.toLowerCase();
  if (unit === "kg") return "kg";
  if (unit === "g") return "g";
  if (unit === "ml") return "ml";
  if (unit === "l" || unit === "litre" || unit === "liter") return "litre";
  return undefined;
};
const generateInternalBarcode = () => {
  const randomParts = crypto.getRandomValues(new Uint32Array(2));
  const randomDigits = ((BigInt(randomParts[0]!) << 32n) | BigInt(randomParts[1]!)) % 10_000_000_000n;
  const data = `20${randomDigits.toString().padStart(10, "0")}`;
  const weightedSum = [...data].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${data}${(10 - (weightedSum % 10)) % 10}`;
};

function PermissionRoute({ module, user, children }: { module: string; user: User; children: ReactNode }) {
  if (user.modules?.includes(module)) return <>{children}</>;
  const landing = getLandingPath(user);
  return landing === window.location.pathname
    ? <AccessDeniedPage />
    : <Navigate to={landing} replace />;
}

function hasTransactionHistoryAccess(user: User): boolean {
  return user.roles.includes("admin")
    || user.modules?.includes("transaction_own") === true
    || user.modules?.includes("transaction_all") === true;
}

function getLandingPath(user: User): string {
  const routeMap: Record<string, string> = {
    dashboard: "/", pos: "/pos", sales: "/sales", products: "/products",
    inventory: "/inventory", purchases: "/purchases", suppliers: "/suppliers",
    customers: "/customers", expenses: "/expenses", shifts: "/shifts",
    reports: "/reports",
  };
  if (user.roles.includes("cashier")) {
    return user.modules?.includes("pos") ? "/pos" : "/access-denied";
  }
  if (user.roles.includes("admin") && user.modules?.includes("dashboard")) return "/";
  const landing = user.defaultLanding;
  if (landing && Object.entries(routeMap).some(([moduleId, route]) =>
    route === landing && user.modules?.includes(moduleId)
      && (moduleId !== "sales" || hasTransactionHistoryAccess(user)))) return landing;
  const fallback = user.modules?.find((moduleId) =>
    routeMap[moduleId] && (moduleId !== "sales" || hasTransactionHistoryAccess(user)));
  return fallback ? routeMap[fallback]! : "/access-denied";
}

const workspaceNavigationItems = [
  { module: "dashboard", route: "/", label: "Overview", icon: <LayoutDashboard size={18} aria-hidden="true" /> },
  { module: "pos", route: "/pos", label: "Point of sale", icon: <ShoppingBasket size={18} aria-hidden="true" /> },
  { module: "products", route: "/products", label: "Products", icon: <Boxes size={18} aria-hidden="true" /> },
  { module: "inventory", route: "/inventory", label: "Inventory", icon: <ArrowLeftRight size={18} aria-hidden="true" /> },
  { module: "purchases", route: "/purchases", label: "Purchasing", icon: <Truck size={18} aria-hidden="true" /> },
  { module: "suppliers", route: "/suppliers", label: "Suppliers", icon: <Users size={18} aria-hidden="true" /> },
  { module: "customers", route: "/customers", label: "Customers", icon: <Users size={18} aria-hidden="true" /> },
  { module: "shifts", route: "/shifts", label: "Cashier shifts", icon: <Banknote size={18} aria-hidden="true" /> },
  { module: "cashier_monitoring", route: "/cashier-monitor", label: "Live cashiers", icon: <Activity size={18} aria-hidden="true" /> },
  { module: "expenses", route: "/expenses", label: "Expenses", icon: <ReceiptText size={18} aria-hidden="true" /> },
  { module: "reports", route: "/reports", label: "Reports", icon: <TrendingUp size={18} aria-hidden="true" /> },
  { module: "sales", route: "/sales", label: "Transaction History", icon: <ReceiptText size={18} aria-hidden="true" /> },
  { module: "branches", route: "/branches", label: "Branches", icon: <Users size={18} aria-hidden="true" /> },
  { module: "sync_monitor", route: "/sync-monitor", label: "Offline sync", icon: <RefreshCw size={18} aria-hidden="true" /> },
  { module: "backups", route: "/backups", label: "Backups", icon: <ShieldCheck size={18} aria-hidden="true" /> },
  { module: "price_history", route: "/price-history", label: "Price history", icon: <ReceiptText size={18} aria-hidden="true" /> },
  { module: "notifications", route: "/notifications", label: "Notifications", icon: <Smartphone size={18} aria-hidden="true" /> },
  { module: "receipts", route: "/receipts", label: "E-receipts", icon: <ReceiptText size={18} aria-hidden="true" /> },
  { module: "comparisons", route: "/comparisons", label: "Comparisons", icon: <TrendingUp size={18} aria-hidden="true" /> },
] as const;

function WorkspaceNavigation({
  user, className, linkClassName, id, showShortcuts = false, onNavigate,
}: { user: User; className: string; linkClassName: string; id?: string; showShortcuts?: boolean; onNavigate?: () => void }) {
  return (
    <nav className={className} id={id} aria-label="Workspace navigation">
      {workspaceNavigationItems.map((item) => user.modules?.includes(item.module)
        && (item.module !== "cashier_monitoring" || user.roles.some((role) => ["admin", "manager"].includes(role)))
        && (item.module !== "sales" || hasTransactionHistoryAccess(user)) ? (
        <NavLink
          key={item.module}
          to={item.route}
          end={item.route === "/"}
          onClick={onNavigate}
          aria-label={item.label}
          title={item.label}
          className={({ isActive }) => `${linkClassName}${isActive ? " active" : ""}`}
        >
          {item.icon}<span>{item.label}</span>{showShortcuts && item.module === "pos" && <span className="nav-shortcut">F2</span>}
        </NavLink>
      ) : null)}
      {user.roles.includes("admin") && user.modules?.includes("permissions") && (
        <NavLink
          to="/staff"
          onClick={onNavigate}
          aria-label="User management"
          title="User management"
          className={({ isActive }) => `${linkClassName}${isActive ? " active" : ""}`}
        >
          <ShieldCheck size={18} aria-hidden="true" /><span>User management</span>
        </NavLink>
      )}
    </nav>
  );
}

function LandingRoute({ user }: { user: User }) {
  const landing = getLandingPath(user);
  if (landing === "/") {
    return <PermissionRoute module="dashboard" user={user}><DashboardPage user={user} /></PermissionRoute>;
  }
  if (landing === "/access-denied") return <AccessDeniedPage />;
  return <Navigate to={landing} replace />;
}

function AccessDeniedPage() {
  return <section className="page-content"><div className="panel access-denied-panel">
    <div className="eyebrow">ACCESS RESTRICTED</div>
    <h1>Access not assigned</h1>
    <p>Your account does not currently have access to an available workspace. Contact an administrator to review your role and permissions.</p>
  </div></section>;
}

function App() {
  if (window.location.pathname === "/mobile-scanner") return <MobileScannerPage />;
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const query = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => (await api.get<{ user: User }>("/auth/me")).data.user,
  });
  if (me.isPending) return <div className="boot-screen"><div className="brand-mark">s</div><span>Opening your workspace…</span></div>;
  if (!me.data) return <LoginPage onLogin={(user) => {
    query.setQueryData(["me"], user);
  }} />;
  if (me.data.mustChangePassword) return <ChangePasswordPage />;
  return (
    <Routes>
      <Route element={<AppShell user={me.data} />}>
        <Route index element={<LandingRoute user={me.data} />} />
        <Route path="/pos" element={<PermissionRoute module="pos" user={me.data}><PosEntryPage user={me.data} /></PermissionRoute>} />
        <Route path="/products" element={<PermissionRoute module="products" user={me.data}><ProductsPage user={me.data} /></PermissionRoute>} />
        <Route path="/inventory" element={<PermissionRoute module="inventory" user={me.data}><InventoryPage user={me.data} /></PermissionRoute>} />
        <Route path="/suppliers" element={<PermissionRoute module="suppliers" user={me.data}><SuppliersPage user={me.data} /></PermissionRoute>} />
        <Route path="/purchases" element={<PermissionRoute module="purchases" user={me.data}><PurchasesPage user={me.data} /></PermissionRoute>} />
        <Route path="/customers" element={<PermissionRoute module="customers" user={me.data}><CustomersPage user={me.data} /></PermissionRoute>} />
        <Route path="/staff" element={<AdminPermissionRoute user={me.data}><StaffPage user={me.data} /></AdminPermissionRoute>} />
        <Route path="/shifts" element={<PermissionRoute module="shifts" user={me.data}><ShiftsPage user={me.data} /></PermissionRoute>} />
        <Route path="/cashier-monitor" element={me.data.modules?.includes("cashier_monitoring") && me.data.roles.some((role) => ["admin", "manager"].includes(role))
          ? <Suspense fallback={<div className="boot-screen">Loading cashier monitoring…</div>}><CashierMonitoringPage user={me.data} /></Suspense>
          : <AccessDeniedPage />} />
        <Route path="/expenses" element={<PermissionRoute module="expenses" user={me.data}><ExpensesPage user={me.data} /></PermissionRoute>} />
        <Route path="/reports" element={<PermissionRoute module="reports" user={me.data}><ReportsPage user={me.data} /></PermissionRoute>} />
        <Route path="/reports/daily" element={<PermissionRoute module="reports" user={me.data}><DailyEvaluationPage user={me.data} /></PermissionRoute>} />
        <Route path="/sales" element={me.data.modules?.includes("sales") && hasTransactionHistoryAccess(me.data)
          ? <SalesPage user={me.data} />
          : <AccessDeniedPage />} />
        <Route path="/branches" element={<PermissionRoute module="branches" user={me.data}><BranchesPage /></PermissionRoute>} />
        <Route path="/sync-monitor" element={<PermissionRoute module="sync_monitor" user={me.data}><OfflineSyncPage /></PermissionRoute>} />
        <Route path="/backups" element={<PermissionRoute module="backups" user={me.data}><BackupsPage /></PermissionRoute>} />
        <Route path="/price-history" element={<PermissionRoute module="price_history" user={me.data}><PriceHistoryPage /></PermissionRoute>} />
        <Route path="/notifications" element={<PermissionRoute module="notifications" user={me.data}><NotificationsPage user={me.data} /></PermissionRoute>} />
        <Route path="/receipts" element={<PermissionRoute module="receipts" user={me.data}><ElectronicReceiptsPage /></PermissionRoute>} />
        <Route path="/comparisons" element={<PermissionRoute module="comparisons" user={me.data}><ComparisonsPage /></PermissionRoute>} />
        <Route path="/access-denied" element={<AccessDeniedPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function AdminPermissionRoute({ user, children }: { user: User; children: ReactNode }) {
  if (user.roles.includes("admin") && user.modules?.includes("permissions")) return <>{children}</>;
  return <AccessDeniedPage />;
}

function ChangePasswordPage() {
  const query = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const schema = z.object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: z.string().min(4, "Use at least 4 characters.").max(200),
    confirmPassword: z.string().min(1, "Confirm your new password."),
  }).refine((values) => values.newPassword === values.confirmPassword, {
    path: ["confirmPassword"], message: "Passwords do not match.",
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const change = useMutation({
    mutationFn: async (values: Values) => api.post("/auth/change-password", {
      currentPassword: values.currentPassword, newPassword: values.newPassword,
    }),
    onSuccess: () => {
      const current = query.getQueryData<User>(["me"]);
      if (current) {
        const updated = { ...current, mustChangePassword: false };
        query.setQueryData(["me"], updated);
        navigate(getLandingPath(updated), { replace: true });
      } else {
        void query.invalidateQueries({ queryKey: ["me"] });
      }
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  return <main className="login-page"><section className="login-card">
    <div className="login-brand"><span className="brand-mark" aria-hidden="true">s</span><strong>Smart<span> POS</span></strong></div>
    <div className="login-form">
      <h1>Update your password</h1>
      <p className="form-description">Your administrator issued a temporary password. Create a new one to continue.</p>
      <form onSubmit={form.handleSubmit((values) => { setError(""); change.mutate(values); })}>
        <label className="field-label" htmlFor="current-password">Temporary password</label>
        <input id="current-password" type="password" autoComplete="current-password" {...form.register("currentPassword")} />
        {form.formState.errors.currentPassword && <small className="field-error">{form.formState.errors.currentPassword.message}</small>}
        <label className="field-label password-label" htmlFor="new-password">New password</label>
        <input id="new-password" type="password" autoComplete="new-password" {...form.register("newPassword")} />
        {form.formState.errors.newPassword && <small className="field-error">{form.formState.errors.newPassword.message}</small>}
        <label className="field-label password-label" htmlFor="confirm-password">Confirm new password</label>
        <input id="confirm-password" type="password" autoComplete="new-password" {...form.register("confirmPassword")} />
        {form.formState.errors.confirmPassword && <small className="field-error">{form.formState.errors.confirmPassword.message}</small>}
        {error && <div role="alert" className="error-banner">{error}</div>}
        <button className="button button-dark login-submit" disabled={change.isPending}>
          {change.isPending ? "Updating…" : "Update password"}
        </button>
      </form>
    </div>
  </section></main>;
}

function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const schema = z.object({ identifier: z.string().trim().min(1, "Username or email is required."), password: z.string().min(1, "Password is required.") });
  type LoginValues = z.infer<typeof schema>;
  const form = useForm<LoginValues>({ resolver: zodResolver(schema), defaultValues: { identifier: "", password: "" } });
  const login = useMutation({
    mutationFn: async (values: LoginValues) => (await api.post<{ user: User }>("/auth/login", values)).data.user,
    onSuccess: (user) => {
      onLogin(user);
      navigate(user.mustChangePassword ? "/change-password" : getLandingPath(user));
    },
    onError: (error) => setMessage(getErrorMessage(error)),
  });
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">s</span>
          <strong>Smart<span> POS</span></strong>
        </div>
        <div className="login-form">
          <h1 id="login-title">Sign in</h1>
          <p className="form-description">Enter your account details to continue.</p>
          <form onSubmit={form.handleSubmit((values) => { setMessage(""); login.mutate(values); })}>
            <label className="field-label" htmlFor="identifier">Username or email</label>
            <input id="identifier" type="text" autoComplete="username" autoFocus placeholder="Enter username or email" {...form.register("identifier")} />
            {form.formState.errors.identifier && <small className="field-error">{form.formState.errors.identifier.message}</small>}
            <label className="field-label password-label" htmlFor="password">Password</label>
            <div className="login-password-row">
              <input id="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Enter password" {...form.register("password")} />
              <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? "Hide" : "Show"}</button>
            </div>
            {form.formState.errors.password && <small className="field-error">{form.formState.errors.password.message}</small>}
            {message && <div role="alert" className="error-banner">{message}</div>}
            <button className="button button-dark login-submit" disabled={login.isPending}>
              {login.isPending ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
        <footer className="login-footer">Smart POS · Retail management</footer>
      </section>
    </main>
  );
}

function AppShell({ user }: { user: User }) {
  const location = useLocation();
  const query = useQueryClient();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: () => { query.clear(); window.location.assign("/"); },
  });
  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 790px)");
    const updateViewport = () => { if (!mediaQuery.matches) setMobileSidebarOpen(false); };
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);
  useEffect(() => setMobileSidebarOpen(false), [location.pathname]);
  const isProducts = location.pathname.startsWith("/products");
  const toggleSidebar = () => setMobileSidebarOpen((open) => !open);
  const pageLabels: Record<string, string> = {
    "/inventory": "Inventory", "/suppliers": "Suppliers", "/purchases": "Purchasing",
    "/customers": "Customers", "/shifts": "Cashier shifts", "/expenses": "Expenses", "/sales": "Sales & returns",
    "/staff": "User management", "/reports": "Reports", "/cashier-monitor": "Live cashiers",
  };
  const pageLabel = pageLabels[location.pathname];
  return (
    <div className={`app-frame${mobileSidebarOpen ? " is-mobile-nav-open" : ""}`}>
      <aside className="sidebar" id="workspace-sidebar">
        <Link to="/" className="brand"><span className="brand-mark">s</span><span>smart<strong>pos</strong></span></Link>
        <div className="branch-switcher"><div className="branch-avatar">M</div><div><strong>Main branch</strong><small>Retail workspace</small></div><ChevronDown size={15} /></div>
        <div className="nav-caption">WORKSPACE</div>
        <WorkspaceNavigation user={user} className="nav-list" linkClassName="nav-item" showShortcuts onNavigate={() => setMobileSidebarOpen(false)} />
        <div className="sidebar-bottom">
          <div className="help-card"><div className="help-icon"><Command size={17} /></div><strong>Need a hand?</strong><p>Your store tools, all in one place.</p></div>
          <button className="user-menu" onClick={() => logout.mutate()} title="Sign out">
            <div className="user-avatar">{user.name.slice(0, 1).toUpperCase()}</div>
            <div className="user-copy"><strong>{user.name}</strong><small>{user.roles[0] ?? "team member"}</small></div>
            <LogOut size={16} className="logout-icon" />
          </button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={mobileSidebarOpen ? "Close navigation" : "Open navigation"}
            aria-controls="workspace-sidebar"
            aria-expanded={mobileSidebarOpen}
            onClick={toggleSidebar}
          >
            {mobileSidebarOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
          </button>
          <WorkspaceNavigation
            user={user}
            className="global-workspace-nav"
            linkClassName="global-workspace-nav-link"
          />
          <div className="topbar-actions">
            <span className="global-workspace-title">{isProducts ? "Products" : pageLabel ?? "Overview"}</span>
            <div className="online-status"><span /> WORKSPACE CONNECTED</div>
            <button className="icon-button" onClick={() => logout.mutate()} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
          </div>
        </header>
        <Outlet />
      </main>
    </div>
  );
}

function DashboardPage({ user }: { user: User }) {
  const summary = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => (await api.get<{ summary: DashboardSummary }>("/dashboard/summary")).data.summary,
  });
  const data = summary.data;
  const isAdmin = user.roles.some((role) => ["admin", "manager"].includes(role));
  const weekSales = data?.salesTrend.reduce((total, point) => total + Number(point.revenue), 0) ?? 0;
  const averageSale = data && data.todayTransactions > 0
    ? Number(data.todaySales) / data.todayTransactions
    : 0;
  return (
    <section className={`page-content dashboard-page${isAdmin ? " admin-overview" : ""}`}>
      <div className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> BUSINESS OVERVIEW · {greeting.toUpperCase()}</div>
          <h1>{timeGreeting}, {user.name.split(" ")[0]}<span className="heading-period">.</span></h1>
          <p>{isAdmin ? "Monitor store performance and operational priorities." : "Here’s what’s happening across your store today."}</p>
        </div>
        <div className="dashboard-heading-actions">
          <span className="dashboard-updated">Updated {summary.dataUpdatedAt ? new Date(summary.dataUpdatedAt).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
          <button className="dashboard-refresh" type="button" onClick={() => void summary.refetch()} disabled={summary.isFetching} aria-label="Refresh dashboard">
            <RefreshCw size={15} className={summary.isFetching ? "dashboard-refreshing" : ""} />
            <span>{summary.isFetching ? "Refreshing" : "Refresh"}</span>
          </button>
          <Link to="/pos" className="button button-dark"><ShoppingCart size={17} /> Start a sale <ArrowUpRight size={16} /></Link>
        </div>
      </div>
      {summary.isError && <ErrorBanner message={getErrorMessage(summary.error)} onRetry={() => void summary.refetch()} />}
      {isAdmin && (
        <div className="admin-operations-strip">
          <div className="admin-operation-status">
            <div className="dashboard-command-icon"><LayoutDashboard size={17} /></div>
            <div><strong>Quick actions</strong><small>Jump directly to a key workspace</small></div>
          </div>
          <div className="admin-quick-actions" aria-label="Quick actions">
            {user.modules?.includes("pos") && <Link to="/pos"><ShoppingCart size={16} /><span>Open POS</span></Link>}
            {user.modules?.includes("products") && <Link to="/products"><PackagePlus size={16} /><span>Add product</span></Link>}
            {user.modules?.includes("inventory") && <Link to="/inventory"><Boxes size={16} /><span>Stock view</span></Link>}
            {user.modules?.includes("reports") && <Link to="/reports"><TrendingUp size={16} /><span>Reports</span></Link>}
          </div>
        </div>
      )}
      {user.modules?.includes("cashier_monitoring") && user.roles.some((role) => ["admin", "manager"].includes(role))
        && <Suspense fallback={<section className="panel cashier-monitor-summary"><div className="loading-rows">Loading live cashiers…</div></section>}><LiveCashierSummary /></Suspense>}
      <div className="metric-grid">
        <MetricCard label="TODAY'S SALES" value={data ? money(data.todaySales) : "—"} caption={`${data?.todayTransactions ?? 0} completed transactions`} icon={<CircleDollarSign size={19} />} tone="green" loading={summary.isPending} />
        <MetricCard label="TRANSACTIONS TODAY" value={data ? String(data.todayTransactions) : "—"} caption="Completed sales today" icon={<ShoppingBasket size={19} />} loading={summary.isPending} />
        <MetricCard label="ACTIVE PRODUCTS" value={data ? String(data.productCount) : "—"} caption="Available in the catalogue" icon={<Boxes size={19} />} loading={summary.isPending} />
        <MetricCard label="LOW STOCK ITEMS" value={data ? String(data.lowStockCount) : "—"} caption="At or below reorder level" icon={<ArrowDownLeft size={19} />} tone="amber" loading={summary.isPending} />
      </div>
      {isAdmin && <section className="panel dashboard-chart-panel">
        <div className="panel-heading">
          <div><div className="eyebrow">SALES PERFORMANCE</div><h2>Revenue over the last 7 days</h2></div>
          <div className="dashboard-chart-stats">
            <div><span>7-DAY REVENUE</span><strong>{data ? money(weekSales) : "—"}</strong></div>
            <div><span>AVERAGE SALE TODAY</span><strong>{data ? money(averageSale) : "—"}</strong></div>
          </div>
        </div>
        {summary.isPending ? <div className="dashboard-chart-loading"><LoadingRows /></div> : data && <Suspense fallback={<div className="dashboard-chart-loading">Loading sales chart…</div>}>
          <DashboardSalesChart salesTrend={data.salesTrend} todayDate={data.todayDate} />
        </Suspense>}
      </section>}
      <div className="dashboard-columns">
        <section className="panel sales-panel">
          <div className="panel-heading"><div><div className="eyebrow">TRANSACTION ACTIVITY</div><h2>Recent sales</h2></div>{user.modules?.includes("sales") && <Link to="/sales" className="text-link">View all <ArrowUpRight size={15} /></Link>}</div>
          {summary.isPending ? <LoadingRows /> : data?.recentSales.length ? <div className="sales-list">
            {data.recentSales.map((sale) => <div className="sale-row" key={sale.id}><div className="receipt-icon"><ShoppingBasket size={17} /></div><div className="sale-details"><strong>{sale.receiptNumber}</strong><small>{sale.cashier} · {new Date(sale.createdAt).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}</small></div><span className={`sale-complete ${sale.status !== "completed" ? "sale-pending" : ""}`}>{sale.status.replace("_", " ").toUpperCase()}</span><strong className="sale-amount">{money(sale.total)}</strong></div>)}
          </div> : <EmptyState title="No sales just yet" detail="Your completed transactions will appear here." /> }
        </section>
        <section className="panel stock-panel">
          <div className="panel-heading"><div><div className="eyebrow">INVENTORY HEALTH</div><h2>Needs attention</h2></div>{user.modules?.includes("inventory") && <Link to="/inventory" className="text-link">Inventory <ArrowUpRight size={15} /></Link>}</div>
          {summary.isPending ? <LoadingRows /> : data?.lowStockProducts.length ? <div className="stock-list">
            {data.lowStockProducts.map((product) => <div className="stock-row" key={product.id}><div className="stock-dot" /><div className="stock-details"><strong>{product.name}</strong><small>Reorder at {Number(product.reorderLevel).toFixed(0)} units</small></div><span className="stock-qty">{Number(product.stock).toFixed(0)} <small>left</small></span></div>)}
          </div> : <EmptyState title="Stock looks healthy" detail="Low-stock items will be listed here." />}
          {user.modules?.includes("inventory") && data && data.lowStockCount > data.lowStockProducts.length && <Link to="/inventory" className="stock-more-link">View {data.lowStockCount - data.lowStockProducts.length} more low-stock items</Link>}
        </section>
      </div>
      <div className="dashboard-footer"><span>Figures reflect completed sales and current inventory.</span>{user.modules?.includes("reports") && <Link to="/reports/daily">Open daily evaluation <ArrowUpRight size={14} /></Link>}</div>
    </section>
  );
}

const productCsvFields = ["sku", "barcode", "name", "brand", "packageSize", "description", "category", "unit", "sellingPrice", "purchasePrice", "taxRate", "reorderLevel", "openingStock", "currentStock"];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell.length === 0) quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (quoted) throw new Error("The CSV file contains an unclosed quoted field.");
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function csvCell(value: string | number | null): string {
  const raw = value === null ? "" : String(value);
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename: string, rows: Array<Array<string | number | null>>) {
  const contents = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([contents], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ProductsPage({ user }: { user: User }) {
  const query = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [stockStatus, setStockStatus] = useState("");
  const [sort, setSort] = useState("name");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [lookupMessage, setLookupMessage] = useState("");
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productFormOpen, setProductFormOpen] = useState(true);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [lookupImageUrl, setLookupImageUrl] = useState<string | null>(null);
  const [barcodeCameraOpen, setBarcodeCameraOpen] = useState(false);
  const [barcodeCameraScanning, setBarcodeCameraScanning] = useState(false);
  const [barcodeCameraError, setBarcodeCameraError] = useState("");
  const [manualLookupBarcode, setManualLookupBarcode] = useState("");
  const [registrationScannerOpen, setRegistrationScannerOpen] = useState(false);
  const [registrationPairing, setRegistrationPairing] = useState<{ id: string; qr: string; expiresAt: string } | null>(null);
  const [registrationScannerError, setRegistrationScannerError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; failures: string[]; failureCount: number } | null>(null);
  const productVideoRef = useRef<HTMLVideoElement>(null);
  const productCameraControlsRef = useRef<{ stop: () => void } | null>(null);
  const productBarcodeHandledRef = useRef(false);
  const barcodeLookupRequestRef = useRef(false);
  const lastLookupBarcodeRef = useRef("");
  const processedRegistrationScansRef = useRef(new Set<string>());
  const registrationScanProcessingRef = useRef(false);
  const autoLookupValuesRef = useRef<Partial<Record<"name" | "brand" | "category" | "packageSize" | "description" | "unit", string>>>({});
  const canManage = user.roles.some((role) => ["admin", "manager", "inventory_manager"].includes(role));
  const schema = z.object({
    sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, dashes, or underscores."),
    barcode: z.string().trim().max(64).optional(),
    name: z.string().trim().min(2).max(180),
    brand: z.string().trim().max(120).optional(),
    packageSize: z.string().trim().min(1, "Packaging size is required.").max(80),
    description: z.string().trim().max(2000).optional(),
    category: z.string().trim().min(2).max(100),
    unit: z.enum(["piece", "packet", "carton", "kg", "g", "litre", "ml"]),
    sellingPrice: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).refine((value) => Number(value) > 0),
    purchasePrice: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).optional().or(z.literal("")),
    taxRate: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((value) => Number(value) <= 100),
    reorderLevel: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
    openingStock: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
  });
  type ProductForm = z.infer<typeof schema>;
  const emptyForm: ProductForm = {
    sku: "", barcode: "", name: "", brand: "", packageSize: "", description: "", category: "", unit: "piece",
    sellingPrice: "", purchasePrice: "", taxRate: "0", reorderLevel: "0", openingStock: "0",
  };
  const form = useForm<ProductForm>({ resolver: zodResolver(schema), defaultValues: emptyForm });
  const barcodeLookup = useMutation({
    mutationFn: async (barcode: string) => (await api.post<{
      found: boolean;
      duplicate?: { id: number; sku: string; name: string; isActive: boolean };
      externalLookupSkipped?: boolean;
      name?: string;
      brand?: string;
      category?: string;
      packageSize?: string;
      description?: string;
      imageUrl?: string;
    }>("/products/lookup/barcode", { barcode })).data,
    onSuccess: (result, barcode) => {
      lastLookupBarcodeRef.current = barcode;
      if (result.duplicate) {
        setLookupImageUrl(null);
        autoLookupValuesRef.current = {};
        const status = result.duplicate.isActive ? "active" : "archived";
        const message = `Barcode already belongs to ${status} product ${result.duplicate.name} (${result.duplicate.sku}).`;
        setLookupMessage(message);
        setFormError(message);
        return;
      }
      if (!result.found) {
        setLookupImageUrl(null);
        autoLookupValuesRef.current = {};
        setLookupMessage(result.externalLookupSkipped
          ? "This barcode format is not supported by the external catalogue. The barcode was kept; enter product details manually."
          : "Barcode not found in Open Food Facts. The barcode was kept; enter product details manually.");
        return;
      }
      autoLookupValuesRef.current = {};
      if (result.name) {
        form.setValue("name", result.name, { shouldDirty: true });
        autoLookupValuesRef.current.name = result.name;
      }
      if (result.brand) {
        form.setValue("brand", result.brand, { shouldDirty: true });
        autoLookupValuesRef.current.brand = result.brand;
      }
      if (result.category) {
        form.setValue("category", result.category, { shouldDirty: true });
        autoLookupValuesRef.current.category = result.category;
      }
      if (result.packageSize) {
        form.setValue("packageSize", result.packageSize, { shouldDirty: true });
        autoLookupValuesRef.current.packageSize = result.packageSize;
        const unit = unitForPackageSize(result.packageSize);
        if (unit) {
          form.setValue("unit", unit, { shouldDirty: true });
          autoLookupValuesRef.current.unit = unit;
        }
      }
      if (result.description) {
        form.setValue("description", result.description, { shouldDirty: true });
        autoLookupValuesRef.current.description = result.description;
      }
      setLookupImageUrl(result.imageUrl ?? null);
      setLookupMessage(`Product information found for ${barcode}. Review and edit it before saving.`);
      setFormError("");
    },
    onError: (error) => {
      setLookupMessage("");
      setFormError(`${getErrorMessage(error)} The scanned barcode remains in the form; enter product details manually.`);
    },
    onSettled: () => { barcodeLookupRequestRef.current = false; },
  });
  const createRegistrationPairing = useMutation({
    mutationFn: async () => {
      if (window.location.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
        throw new Error("Open Smart POS through a trusted, phone-reachable HTTPS address before pairing.");
      }
      const { data } = await api.post<{ id: string; pairToken: string; expiresAt: string }>("/products/scanner/pairing");
      const scannerOrigin = import.meta.env.VITE_PUBLIC_APP_URL?.trim() || window.location.origin;
      const url = new URL("/mobile-scanner", scannerOrigin);
      if (url.protocol !== "https:") throw new Error("The mobile scanner page must be hosted at an HTTPS address.");
      url.hash = new URLSearchParams({ pair: `${data.id}.${data.pairToken}` }).toString();
      const { default: QRCode } = await import("qrcode");
      const qr = await QRCode.toDataURL(url.toString(), { width: 260, margin: 1, errorCorrectionLevel: "M" });
      return { id: data.id, qr, expiresAt: data.expiresAt };
    },
    onSuccess: (pairing) => {
      processedRegistrationScansRef.current.clear();
      setRegistrationPairing(pairing);
      setRegistrationScannerError("");
    },
    onError: (error) => setRegistrationScannerError(getErrorMessage(error)),
  });
  const registrationScannerQuery = useQuery({
    queryKey: ["registration-phone-scanner", registrationPairing?.id],
    queryFn: async () => (await api.get<{
      paired: boolean;
      scannerConnected: boolean;
      scans: Array<{ id: string; barcode: string; createdAt: number }>;
    }>(`/products/scanner/pairing/${registrationPairing!.id}/poll`)).data,
    enabled: Boolean(registrationPairing),
    refetchInterval: 1200,
    retry: false,
  });
  const lookupBarcode = (barcode: string) => {
    const value = barcode.trim();
    if (barcodeLookupRequestRef.current) return;
    if (!/^[\x21-\x7E]{1,64}$/.test(value)) {
      setFormError("Enter a printable barcode of up to 64 characters.");
      return;
    }
    if (lastLookupBarcodeRef.current && lastLookupBarcodeRef.current !== value) {
      for (const [field, previousValue] of Object.entries(autoLookupValuesRef.current) as Array<[keyof typeof autoLookupValuesRef.current, string]>) {
        if (form.getValues(field) === previousValue) {
          form.setValue(field, field === "unit" ? "piece" : "", { shouldDirty: true });
        }
      }
      autoLookupValuesRef.current = {};
      lastLookupBarcodeRef.current = "";
      setLookupImageUrl(null);
    }
    setFormError("");
    setSuccess("");
    setLookupMessage("");
    barcodeLookupRequestRef.current = true;
    barcodeLookup.mutate(value);
  };
  const disconnectRegistrationScanner = useMutation({
    mutationFn: () => api.delete(`/products/scanner/pairing/${registrationPairing!.id}`),
    onSuccess: () => {
      processedRegistrationScansRef.current.clear();
      registrationScanProcessingRef.current = false;
      setRegistrationPairing(null);
      setRegistrationScannerError("");
      void query.removeQueries({ queryKey: ["registration-phone-scanner"] });
    },
    onError: (error) => setRegistrationScannerError(getErrorMessage(error)),
  });
  useEffect(() => {
    const scan = (registrationScannerQuery.data?.scans ?? [])
      .find((item) => !processedRegistrationScansRef.current.has(item.id));
    if (!registrationPairing || !registrationScannerQuery.data?.paired || !scan
      || registrationScanProcessingRef.current) return;
    processedRegistrationScansRef.current.add(scan.id);
    registrationScanProcessingRef.current = true;
    void (async () => {
      let acknowledgement: {
        status: "added" | "unknown" | "rejected" | "error";
        message: string;
        productName?: string;
      };
      try {
        if (lastLookupBarcodeRef.current && lastLookupBarcodeRef.current !== scan.barcode) {
          for (const [field, previousValue] of Object.entries(autoLookupValuesRef.current) as Array<[keyof typeof autoLookupValuesRef.current, string]>) {
            if (form.getValues(field) === previousValue) {
              form.setValue(field, field === "unit" ? "piece" : "", { shouldDirty: true });
            }
          }
          autoLookupValuesRef.current = {};
          lastLookupBarcodeRef.current = "";
          setLookupImageUrl(null);
        }
        form.setValue("barcode", scan.barcode, { shouldDirty: true });
        const result = await barcodeLookup.mutateAsync(scan.barcode);
        if (result.duplicate) {
          acknowledgement = {
            status: "rejected",
            message: `Barcode is already registered to ${result.duplicate.name}.`,
            productName: result.duplicate.name,
          };
        } else if (result.found) {
          acknowledgement = {
            status: "added",
            message: "Product details were sent to the Add Product form. Review them before saving.",
            ...(result.name ? { productName: result.name } : {}),
          };
        } else {
          acknowledgement = {
            status: "unknown",
            message: result.externalLookupSkipped
              ? "Barcode kept. Enter product details manually."
              : "No external product match. Barcode kept; enter product details manually.",
          };
        }
      } catch (error) {
        acknowledgement = { status: "error", message: getErrorMessage(error).slice(0, 200) };
      }
      try {
        await api.post(`/products/scanner/pairing/${registrationPairing.id}/ack`, {
          scanId: scan.id,
          ...acknowledgement,
        });
        setRegistrationScannerError("");
      } catch (error) {
        processedRegistrationScansRef.current.delete(scan.id);
        setRegistrationScannerError(`Could not confirm the phone scan: ${getErrorMessage(error)}`);
      } finally {
        registrationScanProcessingRef.current = false;
        void query.invalidateQueries({ queryKey: ["registration-phone-scanner", registrationPairing.id] });
      }
    })();
  }, [registrationScannerQuery.data, registrationPairing, barcodeLookup, form, query]);
  const stopProductCamera = () => {
    productCameraControlsRef.current?.stop();
    productCameraControlsRef.current = null;
    setBarcodeCameraScanning(false);
  };
  const startProductCamera = async () => {
    setBarcodeCameraError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setBarcodeCameraError("Camera access requires this page to be opened over trusted HTTPS.");
      return;
    }
    const video = productVideoRef.current;
    if (!video) return;
    try {
      const { BrowserMultiFormatReader: Reader } = await import("@zxing/browser");
      const permissionStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
      permissionStream.getTracks().forEach((track) => track.stop());
      const devices = await Reader.listVideoInputDevices();
      const rearCamera = devices.find((device) => /back|rear|environment/i.test(device.label)) ?? devices.at(-1);
      productBarcodeHandledRef.current = false;
      productCameraControlsRef.current = await new Reader().decodeFromVideoDevice(
        rearCamera?.deviceId,
        video,
        (decoded) => {
          if (!decoded || productBarcodeHandledRef.current) return;
          const barcode = decoded.getText().trim();
          if (!/^[\x21-\x7E]{1,64}$/.test(barcode)) {
            setBarcodeCameraError("This code is not a supported printable barcode.");
            return;
          }
          productBarcodeHandledRef.current = true;
          form.setValue("barcode", barcode, { shouldDirty: true });
          setManualLookupBarcode(barcode);
          setBarcodeCameraOpen(false);
          stopProductCamera();
          lookupBarcode(barcode);
        },
      );
      setBarcodeCameraScanning(true);
    } catch (error) {
      setBarcodeCameraError(error instanceof Error ? error.message : "The rear camera could not be started.");
      setBarcodeCameraScanning(false);
    }
  };
  useEffect(() => () => productCameraControlsRef.current?.stop(), []);
  const filters = { search, category, stockStatus, sort, direction };
  const products = useQuery({
    queryKey: ["products", filters, page],
    queryFn: async () => (await api.get<{ products: Product[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(
      "/products", { params: { ...filters, page, pageSize: 20 } },
    )).data,
  });
  const categories = useQuery({
    queryKey: ["product-categories"],
    queryFn: async () => (await api.get<{ categories: string[] }>("/products/categories")).data.categories,
  });
  useEffect(() => {
    setPage(1);
  }, [search, category, stockStatus, sort, direction]);
  useEffect(() => {
    if (!imageFile) { setImagePreview(null); return; }
    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const create = useMutation({
    mutationFn: async (values: ProductForm) => {
      const { data } = await api.post<{ product: { id: number } }>("/products", {
        ...values, barcode: values.barcode || undefined,
      });
      let imageError: string | null = null;
      if (imageFile) {
        try {
          await api.put(`/products/${data.product.id}/image`, imageFile, { headers: { "Content-Type": imageFile.type } });
        } catch (error) {
          imageError = getErrorMessage(error);
        }
      } else if (lookupImageUrl) {
        try {
          await api.post(`/products/${data.product.id}/image/import`, { imageUrl: lookupImageUrl });
        } catch (error) {
          imageError = getErrorMessage(error);
        }
      }
      return imageError;
    },
    onSuccess: (imageError) => {
      form.reset(emptyForm);
      setImageFile(null);
      setLookupImageUrl(null);
      autoLookupValuesRef.current = {};
      lastLookupBarcodeRef.current = "";
      setFormError("");
      setLookupMessage("");
      setSuccess(imageError
        ? `Product saved, but its image could not be uploaded: ${imageError}`
        : "Product saved. Its opening stock is now in the branch ledger.");
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["product-categories"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["dashboard"] });
      setPage(1);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });
  const update = useMutation({
    mutationFn: async (values: ProductForm) => {
      await api.patch(`/products/${editingProduct!.id}`, {
        sku: values.sku, barcode: values.barcode || null, name: values.name,
        brand: values.brand || null, packageSize: values.packageSize || null, description: values.description || null, category: values.category,
        unit: values.unit, sellingPrice: values.sellingPrice, purchasePrice: values.purchasePrice || null,
        taxRate: values.taxRate, reorderLevel: values.reorderLevel,
      });
      let imageError: string | null = null;
      if (imageFile) {
        try {
          await api.put(`/products/${editingProduct!.id}/image`, imageFile, { headers: { "Content-Type": imageFile.type } });
        } catch (error) {
          imageError = getErrorMessage(error);
        }
      } else if (lookupImageUrl) {
        try {
          await api.post(`/products/${editingProduct!.id}/image/import`, { imageUrl: lookupImageUrl });
        } catch (error) {
          imageError = getErrorMessage(error);
        }
      }
      return imageError;
    },
    onSuccess: (imageError) => {
      setEditingProduct(null);
      setImageFile(null);
      setLookupImageUrl(null);
      autoLookupValuesRef.current = {};
      lastLookupBarcodeRef.current = "";
      setLookupMessage("");
      form.reset(emptyForm);
      setSuccess(imageError ? `Product details saved, but its image could not be uploaded: ${imageError}` : "Product details updated.");
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["product-categories"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["reports"] });
      setPage(1);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });
  const removeImage = useMutation({
    mutationFn: (id: number) => api.delete(`/products/${id}/image`),
    onSuccess: () => {
      setImageFile(null);
      setEditingProduct((current) => current ? { ...current, hasImage: false } : current);
      setSuccess("Product image removed.");
      void query.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });
  const archive = useMutation({
    mutationFn: (id: number) => api.patch(`/products/${id}`, { isActive: false }),
    onSuccess: () => {
      setSuccess("Product archived and removed from the active catalogue.");
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["product-categories"] });
      void query.invalidateQueries({ queryKey: ["dashboard"] });
      setPage(1);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });

  const exportProducts = async () => {
    setFormError("");
    try {
      const first = await api.get<{ products: Product[]; pagination: { totalPages: number } }>("/products", {
        params: { ...filters, page: 1, pageSize: 100 },
      });
      const rows = [...first.data.products];
      for (let currentPage = 2; currentPage <= first.data.pagination.totalPages; currentPage += 1) {
        const { data } = await api.get<{ products: Product[] }>("/products", {
          params: { ...filters, page: currentPage, pageSize: 100 },
        });
        rows.push(...data.products);
      }
      downloadCsv("smart-pos-products.csv", [
        productCsvFields,
        ...rows.map((product) => [
          product.sku, product.barcode ?? "", product.name, product.brand ?? "", product.packageSize ?? "", product.description ?? "", product.category, product.unit,
          product.sellingPrice, product.purchasePrice ?? "", product.taxRate, product.reorderLevel, "0", product.stock,
        ]),
      ]);
    } catch (error) {
      setFormError(`Export failed: ${getErrorMessage(error)}`);
    }
  };
  const importProducts = async (file: File) => {
    setImporting(true);
    setImportResult(null);
    setFormError("");
    try {
      const [headerRow, ...dataRows] = parseCsv(await file.text());
      if (!headerRow) throw new Error("The CSV file is empty.");
      if (dataRows.length > 1000) throw new Error("Import supports up to 1,000 products per CSV file.");
      const headerNames = headerRow.map((header) => header.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
      const aliases: Record<string, string[]> = {
        sku: ["sku", "productcode", "code"], barcode: ["barcode"], name: ["name", "productname"],
        brand: ["brand"], packageSize: ["packagesize", "packsize", "size"], description: ["description"],
        category: ["category"], unit: ["unit"], sellingPrice: ["sellingprice", "price"],
        purchasePrice: ["purchaseprice", "purchasecost"], taxRate: ["taxrate", "tax"],
        reorderLevel: ["reorderlevel", "reorderat"], openingStock: ["openingstock", "stock"],
      };
      const columnIndexes = Object.fromEntries(Object.entries(aliases).map(([field, names]) => [
        field, headerNames.findIndex((header) => names.includes(header)),
      ]));
      const requiredFields = ["sku", "name", "category", "unit", "sellingPrice"];
      const missing = requiredFields.filter((field) => columnIndexes[field] === -1);
      if (missing.length) throw new Error(`Missing required CSV columns: ${missing.join(", ")}.`);
      let imported = 0;
      const failures: string[] = [];
      for (const [index, row] of dataRows.entries()) {
        const value = (field: string, fallback = "") => {
          const columnIndex = columnIndexes[field];
          return columnIndex >= 0 ? row[columnIndex]?.trim() ?? fallback : fallback;
        };
        const parsed = schema.safeParse({
          sku: value("sku"), barcode: value("barcode"), name: value("name"),
          brand: value("brand"), packageSize: value("packageSize"), category: value("category"),
          description: value("description"),
          unit: value("unit"), sellingPrice: value("sellingPrice"), purchasePrice: value("purchasePrice"),
          taxRate: value("taxRate", "0") || "0", reorderLevel: value("reorderLevel", "0") || "0",
          openingStock: value("openingStock", "0") || "0",
        });
        if (!parsed.success) {
          failures.push(`Row ${index + 2}: invalid product fields.`);
          continue;
        }
        try {
          await api.post("/products", { ...parsed.data, barcode: parsed.data.barcode || undefined });
          imported += 1;
        } catch (error) {
          failures.push(`Row ${index + 2}: ${getErrorMessage(error)}`);
        }
      }
      setImportResult({ imported, failures: failures.slice(0, 8), failureCount: failures.length });
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["product-categories"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["dashboard"] });
      setPage(1);
    } catch (error) {
      setFormError(`Import failed: ${getErrorMessage(error)}`);
    } finally {
      setImporting(false);
    }
  };

  const rows = products.data?.products ?? [];
  const pagination = products.data?.pagination;
  return (
    <section className="page-content products-page">
      <div className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-dot" /> PRODUCT MANAGEMENT</div><h1>{editingProduct ? "Edit product" : productFormOpen ? "Add a product" : "Product catalogue"}<span className="heading-period">.</span></h1><p>{productFormOpen ? "Scan a barcode to identify products, then review details and stock before saving." : "Manage your products, prices and branch stock levels."}</p></div>
        <div className="products-heading-actions">
          {canManage && !productFormOpen && <button className="button button-dark product-add-button" type="button" onClick={() => { setProductFormOpen(true); setEditingProduct(null); form.reset(emptyForm); }}><Plus size={16} /> Add Product</button>}
          <div className="product-total"><PackagePlus size={17} /> {pagination?.total ?? "—"} PRODUCTS</div>
        </div>
      </div>
      {success && <div role="status" className="success-banner">{success}<button onClick={() => setSuccess("")} aria-label="Dismiss"><X size={15} /></button></div>}
      {formError && <ErrorBanner message={formError} onRetry={() => setFormError("")} />}
      {canManage && productFormOpen && <section className="panel create-product-panel">
        <div className="create-heading"><div className="create-icon"><PackagePlus size={17} /></div><div><div className="eyebrow">PRODUCT REGISTRATION</div><h2>{editingProduct ? "Product information" : "New inventory item"}</h2></div></div>
        <p className="create-description">{editingProduct ? "Update product details while preserving its existing inventory history." : "Identify the product, confirm its details and set the opening stock for this branch."}</p>
        <form className="product-form" onSubmit={form.handleSubmit((values) => { setFormError(""); setSuccess(""); editingProduct ? update.mutate(values) : create.mutate(values); })}>
          <section className="product-scan-panel" aria-labelledby="product-scan-heading">
            <div className="product-scan-copy"><div className="product-scan-icon"><ScanBarcode size={22} /></div><div><h3 id="product-scan-heading">Scan product barcode</h3><p>USB scanners can scan directly here. Look up new barcodes against the local catalogue first, then external product information.</p></div></div>
            <div className="product-scan-controls">
              <label className="product-scan-input" htmlFor="product-registration-barcode">
                <span>Barcode</span>
                <input id="product-registration-barcode" placeholder="Scan or enter barcode" autoComplete="off" {...form.register("barcode")} onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    lookupBarcode(event.currentTarget.value);
                  }
                }} />
              </label>
              <button className="small-action" type="button" disabled={barcodeLookup.isPending} onClick={() => { setBarcodeCameraError(""); setManualLookupBarcode(form.getValues("barcode") ?? ""); setBarcodeCameraOpen(true); }}><Camera size={15} /> Camera</button>
              <button className="small-action product-lookup-button" type="button" disabled={barcodeLookup.isPending} onClick={() => lookupBarcode(form.getValues("barcode") ?? "")}>
                {barcodeLookup.isPending ? <><RefreshCw size={14} className="product-loading-icon" /> Looking up…</> : <><Search size={14} /> Look up</>}
              </button>
              {!editingProduct && <button className="button button-dark product-phone-scanner-button" type="button" disabled={createRegistrationPairing.isPending} onClick={() => {
                setRegistrationScannerOpen(true);
                setRegistrationScannerError("");
                if (!registrationPairing
                  || Date.now() >= Date.parse(registrationPairing.expiresAt)
                  || registrationScannerQuery.data?.paired) {
                  createRegistrationPairing.mutate();
                }
              }}><Smartphone size={16} /> {createRegistrationPairing.isPending ? "Creating QR…" : "Connect Phone Scanner"}</button>}
            </div>
            <div className="product-scan-feedback" aria-live="polite">
              {barcodeLookup.isPending
                ? <><RefreshCw size={14} className="product-loading-icon" /> Checking the catalogue and product sources…</>
                : lookupMessage
                  ? <><ShieldCheck size={14} /> {lookupMessage}</>
                  : form.formState.errors.barcode
                    ? <span className="product-validation-message">{form.formState.errors.barcode.message}</span>
                    : <><ShieldCheck size={14} /> Product details will be retrieved where available and can be edited before saving.</>}
            </div>
            <button className="product-internal-barcode" type="button" onClick={() => {
              form.setValue("barcode", generateInternalBarcode(), { shouldDirty: true });
              setLookupImageUrl(null);
              autoLookupValuesRef.current = {};
              lastLookupBarcodeRef.current = "";
              setLookupMessage("");
              setSuccess("An internal-use EAN-13 barcode was generated. Print or attach a matching label before using it.");
              setFormError("");
            }}>Generate internal EAN-13</button>
          </section>

          <section className="product-information-section" aria-labelledby="product-information-heading">
            <div className="product-section-heading"><div className="product-section-icon"><PackagePlus size={18} /></div><div><h3 id="product-information-heading">Product information</h3><p>Review and edit the product identity and catalogue details.</p></div></div>
            <div className="product-information-layout">
              <div className="product-image-field">
                <span className="product-image-label">Product image</span>
                <div className="product-image-preview">
                  {imagePreview || lookupImageUrl || (editingProduct?.hasImage ? `/api/products/${editingProduct.id}/image` : null)
                    ? <img src={imagePreview ?? lookupImageUrl ?? `/api/products/${editingProduct!.id}/image`} alt="Product preview" />
                    : <div className="product-image-empty"><PackagePlus size={30} /><span>Product image preview</span></div>}
                </div>
                <div className="product-image-actions">
                  <label className="small-action file-action"><Upload size={14} /> Change image<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
                      setFormError("Choose a JPEG, PNG, or WebP image up to 5 MB.");
                    } else {
                      setFormError("");
                      setImageFile(file);
                      setLookupImageUrl(null);
                    }
                    event.currentTarget.value = "";
                  }} /></label>
                  {(imageFile || lookupImageUrl || editingProduct?.hasImage) && <button type="button" className="small-action small-action-danger" disabled={removeImage.isPending} onClick={() => {
                    if (editingProduct?.hasImage && !imageFile && !lookupImageUrl) removeImage.mutate(editingProduct.id);
                    else { setImageFile(null); setLookupImageUrl(null); }
                  }}><Trash2 size={14} /> {removeImage.isPending ? "Removing…" : "Remove image"}</button>}
                </div>
                <small className="product-image-hint">JPEG, PNG or WebP · maximum 5 MB</small>
                {lookupImageUrl && <small className="product-image-hint">Matched image will be saved with this product.</small>}
              </div>
              <div className="product-information-fields">
                <label>Product name <span className="required-mark">*</span><input placeholder="e.g. Long-life milk" {...form.register("name")} />{form.formState.errors.name && <small className="product-validation-message">{form.formState.errors.name.message}</small>}</label>
                <label>Brand<input placeholder="Optional" {...form.register("brand")} /></label>
                <label>Packaging size <span className="required-mark">*</span><input placeholder="e.g. 500 g or 1 L" {...form.register("packageSize")} />{form.formState.errors.packageSize && <small className="product-validation-message">{form.formState.errors.packageSize.message}</small>}</label>
                <label>SKU / product code <span className="required-mark">*</span><input placeholder="e.g. DAIR-012" {...form.register("sku")} />{form.formState.errors.sku && <small className="product-validation-message">Enter a valid product code.</small>}</label>
                <label>Category<input placeholder="e.g. Dairy" list="product-category-options" {...form.register("category")} /><datalist id="product-category-options">{categories.data?.map((item) => <option value={item} key={item} />)}</datalist>{form.formState.errors.category && <small className="product-validation-message">Enter a product category.</small>}</label>
                <label>Unit of measurement<select {...form.register("unit")}><option value="piece">Piece</option><option value="packet">Packet</option><option value="carton">Carton</option><option value="kg">Kilogram</option><option value="g">Gram</option><option value="litre">Litre</option><option value="ml">Millilitre</option></select></label>
                <label className="product-description-field">Product description<textarea rows={3} placeholder="Optional product description" {...form.register("description")} />{form.formState.errors.description && <small className="product-validation-message">Description must be 2,000 characters or fewer.</small>}</label>
              </div>
            </div>
          </section>

          <section className="product-business-section" aria-labelledby="product-business-heading">
            <div className="product-section-heading"><div className="product-section-icon business"><CircleDollarSign size={18} /></div><div><h3 id="product-business-heading">Business details</h3><p>Set prices and stock thresholds for this branch.</p></div></div>
            <div className="product-business-fields">
              <label>Purchase price (KES)<input inputMode="decimal" placeholder="0.00" {...form.register("purchasePrice")} />{form.formState.errors.purchasePrice && <small className="product-validation-message">Enter a valid purchase price.</small>}</label>
              <label>Selling price (KES) <span className="required-mark">*</span><input inputMode="decimal" placeholder="0.00" {...form.register("sellingPrice")} />{form.formState.errors.sellingPrice && <small className="product-validation-message">Enter a valid selling price.</small>}</label>
              {!editingProduct && <label>Opening stock <span className="required-mark">*</span><input inputMode="decimal" placeholder="0" {...form.register("openingStock")} />{form.formState.errors.openingStock && <small className="product-validation-message">Enter a valid opening quantity.</small>}</label>}
              <label>Minimum stock level<input inputMode="decimal" placeholder="0" {...form.register("reorderLevel")} />{form.formState.errors.reorderLevel && <small className="product-validation-message">Enter a valid minimum quantity.</small>}</label>
              <label>Tax rate (%)<input inputMode="decimal" placeholder="0" {...form.register("taxRate")} />{form.formState.errors.taxRate && <small className="product-validation-message">Use a rate from 0 to 100.</small>}</label>
            </div>
          </section>

          <div className="product-form-actions">
            <div className="product-form-note"><ShieldCheck size={15} /> Opening stock is recorded in the branch stock ledger.</div>
            <div className="product-form-buttons">
              <button type="button" className="small-action" onClick={() => {
                if (editingProduct) {
                  form.reset({
                    sku: editingProduct.sku, barcode: editingProduct.barcode ?? "", name: editingProduct.name,
                    brand: editingProduct.brand ?? "", packageSize: editingProduct.packageSize ?? "", description: editingProduct.description ?? "", category: editingProduct.category,
                    unit: editingProduct.unit as ProductForm["unit"], sellingPrice: editingProduct.sellingPrice,
                    purchasePrice: editingProduct.purchasePrice ?? "", taxRate: editingProduct.taxRate,
                    reorderLevel: editingProduct.reorderLevel, openingStock: "0",
                  });
                } else form.reset(emptyForm);
                setImageFile(null);
                setLookupImageUrl(null);
                autoLookupValuesRef.current = {};
                lastLookupBarcodeRef.current = "";
                setLookupMessage("");
                setFormError("");
              }}><RotateCcw size={14} /> Reset</button>
              <button type="button" className="small-action" onClick={() => {
                setEditingProduct(null);
                setProductFormOpen(false);
                form.reset(emptyForm);
                setImageFile(null);
                setLookupImageUrl(null);
                autoLookupValuesRef.current = {};
                lastLookupBarcodeRef.current = "";
                setLookupMessage("");
                setFormError("");
                document.getElementById("product-catalogue")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}>Cancel</button>
              <button className="button button-dark create-product-button" disabled={create.isPending || update.isPending}><Plus size={16} /> {editingProduct ? update.isPending ? "Updating…" : "Save changes" : create.isPending ? "Saving product…" : "Save Product"}</button>
            </div>
          </div>
        </form>
      </section>}
      <section id="product-catalogue" className="panel product-table-panel">
        <div className="products-toolbar">
          <div><div className="eyebrow">PRODUCT LIST</div><h2>Catalogue</h2></div>
          <label className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find by name, SKU or barcode" /></label>
        </div>
        <div className="catalogue-controls">
          <select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>{categories.data?.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
          <select aria-label="Filter by stock status" value={stockStatus} onChange={(event) => setStockStatus(event.target.value)}>
            <option value="">All stock statuses</option><option value="in_stock">In stock</option><option value="low_stock">Low stock</option><option value="out_of_stock">Out of stock</option>
          </select>
          <select aria-label="Sort products" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="name">Sort: Name</option><option value="price">Sort: Selling price</option><option value="stock">Sort: Stock quantity</option>
          </select>
          <button className="small-action" type="button" onClick={() => setDirection((current) => current === "asc" ? "desc" : "asc")} title={`Sort ${direction === "asc" ? "ascending" : "descending"}`}><ArrowUpDown size={14} /> {direction === "asc" ? "Ascending" : "Descending"}</button>
          {canManage && <>
            <label className={`small-action file-action ${importing ? "is-disabled" : ""}`}><Upload size={14} /> {importing ? "Importing…" : "Import CSV"}<input type="file" accept=".csv,text/csv" disabled={importing} onChange={(event) => { const file = event.target.files?.[0]; if (file) { if (file.size > 5 * 1024 * 1024) setFormError("CSV files must be 5 MB or smaller."); else void importProducts(file); } event.currentTarget.value = ""; }} /></label>
          </>}
          <button className="small-action" type="button" onClick={() => void exportProducts()}><Download size={14} /> Export CSV</button>
        </div>
        {importResult && <div role="status" className="import-result">
          <strong>Imported {importResult.imported} product{importResult.imported === 1 ? "" : "s"}.</strong>
          {importResult.failureCount > 0 && <span>{importResult.failureCount} row(s) need attention: {importResult.failures.join(" · ")}{importResult.failureCount > importResult.failures.length ? " · More errors omitted" : ""}</span>}
        </div>}
        {products.isError && <ErrorBanner message={getErrorMessage(products.error)} onRetry={() => void products.refetch()} />}
        {categories.isError && <ErrorBanner message={getErrorMessage(categories.error)} onRetry={() => void categories.refetch()} />}
        {products.isPending ? <LoadingRows /> : rows.length ? <>
          <div className="product-table-wrap"><table className="product-table catalogue-table">
            <thead><tr><th>PRODUCT</th><th>SKU / BARCODE</th><th>CATEGORY</th><th>SELLING PRICE</th><th>PURCHASE COST</th><th>AVAILABLE</th><th>STATUS</th>{canManage && <th>ACTION</th>}</tr></thead>
            <tbody>{rows.map((product) => {
              const stock = Number(product.stock);
              const status = stock <= 0 ? "OUT OF STOCK" : stock <= Number(product.reorderLevel) ? "LOW STOCK" : "IN STOCK";
              const statusClass = stock <= 0 ? "status-out" : status === "LOW STOCK" ? "status-low" : "";
              return <tr key={product.id}>
                <td><div className="table-product-name">
                  {product.hasImage
                    ? <img className="product-thumbnail" src={`/api/products/${product.id}/image`} alt="" loading="lazy" />
                    : <span>{product.name.slice(0, 1).toUpperCase()}</span>}
                  <div><strong>{product.name}</strong><small>{[product.brand, product.packageSize || product.unit].filter(Boolean).join(" · ")}</small></div>
                </div></td>
                <td className="sku-cell">{product.sku}<small className="secondary-code">{product.barcode || "No barcode"}</small></td>
                <td>{product.category}</td>
                <td className="price-cell">{money(product.sellingPrice)}</td>
                <td>{product.purchasePrice ? money(product.purchasePrice) : "—"}</td>
                <td className="stock-cell">{Number(product.stock).toLocaleString("en-KE", { maximumFractionDigits: 3 })}</td>
                <td><span className={`product-status ${statusClass}`}><i /> {status}</span></td>
                {canManage && <td className="row-actions">
                  <button className="small-action" onClick={() => {
                    setEditingProduct(product);
                    setProductFormOpen(true);
                    setImageFile(null);
                    setLookupImageUrl(null);
                    autoLookupValuesRef.current = {};
                    lastLookupBarcodeRef.current = "";
                    setFormError("");
                    setLookupMessage("");
                    form.reset({
                      sku: product.sku, barcode: product.barcode ?? "", name: product.name,
                      brand: product.brand ?? "", packageSize: product.packageSize ?? "", description: product.description ?? "", category: product.category,
                      unit: product.unit as ProductForm["unit"], sellingPrice: product.sellingPrice,
                      purchasePrice: product.purchasePrice ?? "", taxRate: product.taxRate,
                      reorderLevel: product.reorderLevel, openingStock: "0",
                    });
                  }}>Edit</button>
                  {stock <= 0 && <button className="small-action small-action-danger" onClick={() => archive.mutate(product.id)} disabled={archive.isPending}>Archive</button>}
                </td>}
              </tr>;
            })}</tbody>
          </table></div>
          <div className="catalogue-pagination">
            <span>Showing {(page - 1) * (pagination?.pageSize ?? 20) + 1}–{Math.min(page * (pagination?.pageSize ?? 20), pagination?.total ?? 0)} of {pagination?.total ?? 0}</span>
            <div><button className="small-action" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button><span>Page {page} of {Math.max(pagination?.totalPages ?? 1, 1)}</span><button className="small-action" disabled={page >= (pagination?.totalPages ?? 1)} onClick={() => setPage((current) => current + 1)}>Next</button></div>
          </div>
        </> : <EmptyState title="No products match these filters" detail="Adjust the search or filters, or register a new product." />}
      </section>
      {barcodeCameraOpen && <div className="product-barcode-backdrop" role="dialog" aria-modal="true" aria-labelledby="product-barcode-title">
        <section className="product-barcode-dialog">
          <button className="product-barcode-close" type="button" aria-label="Close barcode scanner" onClick={() => { setBarcodeCameraOpen(false); stopProductCamera(); }}><X size={18} /></button>
          <span className="eyebrow">PRODUCT LOOKUP</span>
          <h2 id="product-barcode-title">Scan a product barcode</h2>
          <p>Use your device camera or enter the barcode manually. Product details are retrieved from Open Food Facts when available.</p>
          <video ref={productVideoRef} muted playsInline autoPlay aria-label="Live barcode camera preview" />
          {barcodeCameraError && <div className="pos-login-error" role="alert">{barcodeCameraError}</div>}
          <div className="product-barcode-dialog-actions">
            {!barcodeCameraScanning
              ? <button className="button button-dark" type="button" onClick={() => void startProductCamera()}><Camera size={15} /> Start camera</button>
              : <button className="small-action" type="button" onClick={stopProductCamera}><CameraOff size={15} /> Stop camera</button>}
          </div>
          <form className="product-barcode-manual" onSubmit={(event) => {
            event.preventDefault();
            const barcode = manualLookupBarcode.trim();
            if (!/^[\x21-\x7E]{1,64}$/.test(barcode)) {
              setBarcodeCameraError("Enter a printable barcode of up to 64 characters.");
              return;
            }
            form.setValue("barcode", barcode, { shouldDirty: true });
            setBarcodeCameraOpen(false);
            stopProductCamera();
            lookupBarcode(barcode);
          }}>
            <label htmlFor="manual-product-barcode">Manual barcode entry</label>
            <div><input id="manual-product-barcode" value={manualLookupBarcode} onChange={(event) => setManualLookupBarcode(event.target.value)} autoComplete="off" maxLength={64} />
              <button className="small-action" type="submit" disabled={barcodeLookup.isPending}>{barcodeLookup.isPending ? "Looking up…" : "Use & look up"}</button></div>
          </form>
          <small>Supports EAN-13, EAN-8, UPC-A, UPC-E and Code 128. Internet product lookup is available for EAN/UPC formats only. Camera access requires HTTPS.</small>
        </section>
      </div>}
      {registrationScannerOpen && <div className="pos-confirm-screen phone-pairing-screen" role="dialog" aria-modal="true" aria-labelledby="registration-scanner-title">
        <section className="phone-pairing-card">
          <button className="phone-pairing-close" aria-label="Close phone scanner pairing" onClick={() => setRegistrationScannerOpen(false)}><X size={18} /></button>
          <span className="pos-confirm-eyebrow">PRODUCT REGISTRATION</span>
          <h2 id="registration-scanner-title">Connect Phone Scanner</h2>
          <p>Scan this temporary QR code with Android. Scanned barcodes are checked against your catalogue, then new EAN/UPC codes are looked up online and filled into this form.</p>
          {(window.location.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(window.location.hostname)) && <div className="phone-pairing-notice" role="note">
            A pairing QR code cannot be created from {window.location.origin}. Open Smart POS at a trusted HTTPS address reachable by both this computer and your phone, then try again.
          </div>}
          {registrationScannerError && <div className="pos-login-error" role="alert">{registrationScannerError}</div>}
          {registrationPairing && registrationScannerQuery.data?.paired ? <div className={`phone-pairing-status ${registrationScannerQuery.data.scannerConnected ? "connected" : ""}`}>
            <Smartphone size={19} /><div><strong>{registrationScannerQuery.data.scannerConnected ? "Phone scanner connected" : "Phone paired"}</strong><span>{registrationScannerQuery.data.scannerConnected ? "Ready to scan a new product barcode." : "Waiting for the phone scanner to reconnect."}</span></div>
          </div> : registrationPairing && Date.now() < Date.parse(registrationPairing.expiresAt)
            ? <img className="phone-pairing-qr" src={registrationPairing.qr} alt="One-time product registration pairing QR code" />
            : <div className="phone-pairing-placeholder"><QrCode size={28} /><span>{createRegistrationPairing.isPending ? "Creating secure pairing code…" : "Create a short-lived pairing QR code."}</span></div>}
          {registrationScannerQuery.isError && <div className="pos-login-error" role="alert">{getErrorMessage(registrationScannerQuery.error)}</div>}
          <div className="phone-pairing-actions">
            {registrationScannerQuery.data?.paired && <button className="cancel" disabled={disconnectRegistrationScanner.isPending} onClick={() => disconnectRegistrationScanner.mutate()}>
              {disconnectRegistrationScanner.isPending ? "Disconnecting…" : "Disconnect phone"}
            </button>}
            {!registrationPairing || Date.now() >= Date.parse(registrationPairing.expiresAt) || registrationScannerQuery.data?.paired
              ? <button className="confirm" disabled={createRegistrationPairing.isPending} onClick={() => createRegistrationPairing.mutate()}>
                {createRegistrationPairing.isPending ? "Creating…" : registrationScannerQuery.data?.paired ? "Pair another phone" : "Create pairing QR"}
              </button>
              : <span>Pairing code expires at {new Date(registrationPairing.expiresAt).toLocaleTimeString("en-KE")}.</span>}
            <button className="cancel" onClick={() => setRegistrationScannerOpen(false)}>Close</button>
          </div>
          <small className="phone-pairing-security">A trusted HTTPS app and backend are required. The QR code is single-use and expires after 90 seconds.</small>
        </section>
      </div>}
    </section>
  );
}

function InventoryPage({ user }: { user: User }) {
  const query = useQueryClient();
  const [search, setSearch] = useState("");
  const [stockFilter, setStockFilter] = useState("");
  const [inventorySort, setInventorySort] = useState("name");
  const [inventoryDirection, setInventoryDirection] = useState<"asc" | "desc">("asc");
  const [inventoryPage, setInventoryPage] = useState(1);
  const [error, setError] = useState("");
  const adjustmentRef = useRef<HTMLElement | null>(null);
  const canAdjust = user.roles.some((role) => ["admin", "manager", "inventory_manager"].includes(role));
  const inventorySummary = useQuery({
    queryKey: ["inventory-summary"],
    queryFn: async () => (await api.get<{ summary: {
      totalProducts: number; totalStock: string; lowStockProducts: number;
      outOfStockProducts: number; stockValuation: string; uncostedProducts: number;
    } }>("/inventory/summary")).data.summary,
  });
  const inventory = useQuery({
    queryKey: ["inventory", search],
    queryFn: async () => (await api.get<{ items: Array<{
      id: number; sku: string; name: string; category: string; unit: string; onHand: string;
      reserved: string; available: string; reorderLevel: string; updatedAt: string; hasImage: boolean; cost: string | null;
    }>; movements: Array<{
      id: number; product: string; sku: string; type: string; quantity: string;
      reference: string | null; createdBy: string; createdAt: string;
    }> }>("/inventory", { params: { search } })).data,
  });
  useEffect(() => {
    setInventoryPage(1);
  }, [search, stockFilter, inventorySort, inventoryDirection]);
  const [productId, setProductId] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [selectedTakeId, setSelectedTakeId] = useState<number | null>(null);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [transferDestinationId, setTransferDestinationId] = useState("");
  const [transferLines, setTransferLines] = useState([{ productId: "", quantity: "1" }]);
  const [transferNotes, setTransferNotes] = useState("");
  const [selectedTransferId, setSelectedTransferId] = useState<number | null>(null);
  const [receivedQuantities, setReceivedQuantities] = useState<Record<number, string>>({});
  const adjust = useMutation({
    mutationFn: () => api.post("/inventory/adjustments", {
      productId: Number(productId), direction, quantity, reason,
      batchCode: batchCode || undefined, expiryDate: direction === "in" && expiryDate ? expiryDate : undefined,
    }),
    onSuccess: () => {
      setReason("");
      setError("");
      void query.invalidateQueries({ queryKey: ["inventory"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const expiry = useQuery({
    queryKey: ["inventory-expiry"],
    queryFn: async () => (await api.get<{ batches: Array<{
      id: number; productId: number; name: string; sku: string; batchCode: string | null;
      expiryDate: string; quantity: string; unit: string;
    }> }>("/inventory/expiry", { params: { days: 90 } })).data.batches,
    enabled: canAdjust,
  });
  const stockTakes = useQuery({
    queryKey: ["stock-takes"],
    queryFn: async () => (await api.get<{ stockTakes: Array<{
      id: number; reference: string; title: string; status: string; createdAt: string;
      countedItems: number; totalItems: number;
    }> }>("/inventory/stock-takes")).data.stockTakes,
    enabled: canAdjust,
  });
  const transferBranches = useQuery({
    queryKey: ["transfer-branches"],
    queryFn: async () => (await api.get<{ branches: Array<{ id: number; name: string; code: string }> }>("/inventory/transfer-branches")).data.branches,
    enabled: canAdjust,
  });
  const transferProducts = useQuery({
    queryKey: ["transfer-products"],
    queryFn: async () => (await api.get<{ products: Array<{ id: number; sku: string; name: string; unit: string; stock: string }> }>("/products")).data.products,
    enabled: canAdjust,
  });
  const transfers = useQuery({
    queryKey: ["inventory-transfers"],
    queryFn: async () => (await api.get<{ transfers: Array<{
      id: number; reference: string; sourceBranchId: number; sourceBranch: string; destinationBranchId: number;
      destinationBranch: string; status: string; createdAt: string; itemCount: number;
      quantityDispatched: string | null; quantityReceived: string | null;
    }> }>("/inventory/transfers")).data.transfers,
    enabled: canAdjust,
  });
  const selectedTransfer = useQuery({
    queryKey: ["inventory-transfer", selectedTransferId],
    queryFn: async () => (await api.get<{ transfer: {
      id: number; reference: string; sourceBranchId: number; sourceBranch: string; destinationBranchId: number;
      destinationBranch: string; status: string; notes: string | null;
      items: Array<{
        productId: number; sku: string; name: string; unit: string; quantityRequested: string;
        quantityDispatched: string | null; quantityReceived: string | null; quantityVariance: string | null;
      }>;
    } }>(`/inventory/transfers/${selectedTransferId}`)).data.transfer,
    enabled: canAdjust && selectedTransferId !== null,
  });
  const selectedTake = useQuery({
    queryKey: ["stock-take", selectedTakeId],
    queryFn: async () => (await api.get<{ stockTake: {
      id: number; reference: string; title: string; status: string;
      items: Array<{ productId: number; sku: string; name: string; unit: string; expectedQuantity: string; countedQuantity: string | null }>;
    } }>(`/inventory/stock-takes/${selectedTakeId}`)).data.stockTake,
    enabled: canAdjust && selectedTakeId !== null,
  });
  const startTake = useMutation({
    mutationFn: async () => (await api.post<{ id: number }>("/inventory/stock-takes", { title: `Stock count · ${new Date().toLocaleDateString("en-KE")}` })).data,
    onSuccess: (take) => {
      setSelectedTakeId(take.id);
      setCounts({});
      void query.invalidateQueries({ queryKey: ["stock-takes"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const completeTake = useMutation({
    mutationFn: () => api.post(`/inventory/stock-takes/${selectedTakeId}/complete`, {
      items: selectedTake.data!.items.map((item) => ({
        productId: item.productId,
        countedQuantity: counts[item.productId] ?? item.countedQuantity ?? "",
      })),
    }),
    onSuccess: () => {
      setSelectedTakeId(null);
      setCounts({});
      setError("");
      void query.invalidateQueries({ queryKey: ["stock-takes"] });
      void query.invalidateQueries({ queryKey: ["inventory"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["inventory-expiry"] });
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const createTransfer = useMutation({
    mutationFn: async () => (await api.post<{ id: number }>("/inventory/transfers", {
      destinationBranchId: Number(transferDestinationId),
      notes: transferNotes,
      items: transferLines.map((item) => ({ productId: Number(item.productId), quantity: item.quantity })),
    })).data,
    onSuccess: () => {
      setTransferLines([{ productId: "", quantity: "1" }]);
      setTransferNotes("");
      setError("");
      void query.invalidateQueries({ queryKey: ["inventory-transfers"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const dispatchTransfer = useMutation({
    mutationFn: (id: number) => api.post(`/inventory/transfers/${id}/dispatch`),
    onSuccess: () => {
      setError("");
      void query.invalidateQueries({ queryKey: ["inventory-transfers"] });
      void query.invalidateQueries({ queryKey: ["inventory"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const receiveTransfer = useMutation({
    mutationFn: () => api.post(`/inventory/transfers/${selectedTransferId}/receive`, {
      items: selectedTransfer.data!.items.map((item) => ({
        productId: item.productId,
        receivedQuantity: receivedQuantities[item.productId] ?? item.quantityDispatched ?? "0",
      })),
    }),
    onSuccess: () => {
      setSelectedTransferId(null);
      setReceivedQuantities({});
      setError("");
      void query.invalidateQueries({ queryKey: ["inventory-transfers"] });
      void query.invalidateQueries({ queryKey: ["inventory"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["inventory-expiry"] });
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const takeCompleteEnabled = Boolean(selectedTake.data?.items.length)
    && selectedTake.data!.items.every((item) => /^\d{1,9}(\.\d{1,3})?$/.test(counts[item.productId] ?? item.countedQuantity ?? ""));
  const transferCreateEnabled = Boolean(transferDestinationId)
    && transferLines.length > 0
    && transferLines.every((item) => /^[1-9]\d*$/.test(item.productId) && /^\d{1,9}(\.\d{1,3})?$/.test(item.quantity) && Number(item.quantity) > 0);
  const transferReceiveEnabled = Boolean(selectedTransfer.data?.items.length)
    && selectedTransfer.data!.items.every((item) => {
      const value = receivedQuantities[item.productId] ?? item.quantityDispatched ?? "";
      return /^\d{1,9}(\.\d{1,3})?$/.test(value) && Number(value) <= Number(item.quantityDispatched);
    });
  const filteredInventory = (inventory.data?.items ?? [])
    .filter((item) => {
      const available = Number(item.available);
      if (stockFilter === "in_stock") return available > Number(item.reorderLevel);
      if (stockFilter === "low_stock") return available > 0 && available <= Number(item.reorderLevel);
      if (stockFilter === "out_of_stock") return available <= 0;
      return true;
    })
    .sort((first, second) => {
      const result = inventorySort === "stock"
        ? Number(first.available) - Number(second.available)
        : inventorySort === "updated"
          ? Date.parse(first.updatedAt) - Date.parse(second.updatedAt)
          : first.name.localeCompare(second.name);
      return inventoryDirection === "asc" ? result : -result;
    });
  const inventoryPageSize = 20;
  const inventoryPageCount = Math.max(1, Math.ceil(filteredInventory.length / inventoryPageSize));
  const inventoryPageItems = filteredInventory.slice((inventoryPage - 1) * inventoryPageSize, inventoryPage * inventoryPageSize);
  return (
    <section className="page-content operations-page inventory-page">
      <PageHeader eyebrow="STOCK CONTROL" title="Inventory" detail="Branch stock balances and an auditable movement ledger." />
      {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
      {inventory.isError && <ErrorBanner message={getErrorMessage(inventory.error)} onRetry={() => void inventory.refetch()} />}
      {inventorySummary.isError && <ErrorBanner message={getErrorMessage(inventorySummary.error)} onRetry={() => void inventorySummary.refetch()} />}
      <div className="inventory-metrics">
        <div className="inventory-metric"><span>TOTAL PRODUCTS</span><strong>{inventorySummary.data?.totalProducts ?? "—"}</strong><small>Active catalogue items</small></div>
        <div className="inventory-metric"><span>STOCK QUANTITY</span><strong>{inventorySummary.data ? Number(inventorySummary.data.totalStock).toLocaleString("en-KE", { maximumFractionDigits: 3 }) : "—"}</strong><small>Available units</small></div>
        <button aria-pressed={stockFilter === "low_stock"} className={`inventory-metric metric-warning ${stockFilter === "low_stock" ? "selected" : ""}`} onClick={() => setStockFilter((current) => current === "low_stock" ? "" : "low_stock")}><span>LOW STOCK</span><strong>{inventorySummary.data?.lowStockProducts ?? "—"}</strong><small>At or below reorder level</small></button>
        <button aria-pressed={stockFilter === "out_of_stock"} className={`inventory-metric metric-danger ${stockFilter === "out_of_stock" ? "selected" : ""}`} onClick={() => setStockFilter((current) => current === "out_of_stock" ? "" : "out_of_stock")}><span>OUT OF STOCK</span><strong>{inventorySummary.data?.outOfStockProducts ?? "—"}</strong><small>Needs replenishment</small></button>
        <div className="inventory-metric metric-value-card"><span>STOCK VALUATION</span><strong>{inventorySummary.data ? money(inventorySummary.data.stockValuation) : "—"}</strong><small>{inventorySummary.data?.uncostedProducts ? `Excludes ${inventorySummary.data.uncostedProducts} products without cost` : "At purchase cost"}</small></div>
      </div>
      {canAdjust && <section ref={adjustmentRef} className="panel operation-form-panel">
        <div className="panel-heading"><div><div className="eyebrow">STOCK ADJUSTMENT</div><h2>Record a stock movement</h2></div></div>
        <form className="operation-form" onSubmit={(event) => { event.preventDefault(); setError(""); adjust.mutate(); }}>
          <label>Product<select value={productId} onChange={(event) => setProductId(event.target.value)} required><option value="">Select product</option>{inventory.data?.items.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.sku}</option>)}</select></label>
          <label>Movement<select value={direction} onChange={(event) => setDirection(event.target.value as "in" | "out")}><option value="in">Stock in</option><option value="out">Stock out</option></select></label>
          <label>Quantity<input value={quantity} inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} required /></label>
          <label>Reason<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Stock count correction" minLength={3} required /></label>
          {direction === "in" && <>
            <label>Batch / lot code<input value={batchCode} onChange={(event) => setBatchCode(event.target.value)} placeholder="Optional" /></label>
            <label>Expiry date<input type="date" value={expiryDate} onChange={(event) => setExpiryDate(event.target.value)} /></label>
          </>}
          <button className="button button-dark" disabled={adjust.isPending || !productId}>{adjust.isPending ? "Saving…" : "Record movement"}</button>
        </form>
      </section>}
      <section className="panel operation-table-panel">
        <div className="products-toolbar"><div><div className="eyebrow">BRANCH BALANCES</div><h2>On-hand inventory</h2></div><label className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or SKU" /></label></div>
        <div className="inventory-controls">
          <select aria-label="Filter inventory by stock status" value={stockFilter} onChange={(event) => setStockFilter(event.target.value)}>
            <option value="">All stock statuses</option><option value="in_stock">In stock</option><option value="low_stock">Low stock</option><option value="out_of_stock">Out of stock</option>
          </select>
          <select aria-label="Sort inventory" value={inventorySort} onChange={(event) => setInventorySort(event.target.value)}>
            <option value="name">Sort: Product name</option><option value="stock">Sort: Available stock</option><option value="updated">Sort: Last updated</option>
          </select>
          <button className="small-action" type="button" onClick={() => setInventoryDirection((current) => current === "asc" ? "desc" : "asc")}><ArrowUpDown size={14} /> {inventoryDirection === "asc" ? "Ascending" : "Descending"}</button>
        </div>
        {inventory.data?.items.length === 250 && <p className="inventory-result-limit">Showing at most 250 matching products. Narrow the search to find other items.</p>}
        {inventory.isPending ? <LoadingRows /> : <div className="product-table-wrap"><table className="product-table inventory-table"><thead><tr><th>PRODUCT</th><th>SKU</th><th>CURRENT STOCK</th><th>RESERVED</th><th>AVAILABLE</th><th>REORDER LEVEL</th><th>STATUS</th><th>LAST UPDATED</th>{canAdjust && <th>ACTION</th>}</tr></thead><tbody>
          {inventoryPageItems.map((item) => {
            const available = Number(item.available);
            const status = available <= 0 ? "OUT OF STOCK" : available <= Number(item.reorderLevel) ? "LOW STOCK" : "IN STOCK";
            const statusClass = available <= 0 ? "status-out" : status === "LOW STOCK" ? "status-low" : "";
            return <tr key={item.id}>
              <td><div className="table-product-name">
                {item.hasImage ? <img className="product-thumbnail" src={`/api/products/${item.id}/image`} alt="" loading="lazy" /> : <span>{item.name.slice(0, 1).toUpperCase()}</span>}
                <div><strong>{item.name}</strong><small>{item.category} · {item.unit}</small></div>
              </div></td>
              <td className="sku-cell">{item.sku}</td><td className="stock-cell">{Number(item.onHand).toFixed(3)}</td>
              <td>{Number(item.reserved).toFixed(3)}</td><td className="stock-cell">{available.toFixed(3)}</td>
              <td>{Number(item.reorderLevel).toFixed(3)}</td>
              <td><span className={`product-status ${statusClass}`}><i /> {status}</span></td>
              <td>{new Date(item.updatedAt).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })}</td>
              {canAdjust && <td><button className="small-action" onClick={() => { setProductId(String(item.id)); adjustmentRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>Adjust</button></td>}
            </tr>;
          })}
        </tbody></table>{!inventoryPageItems.length && <EmptyState title="No inventory to show" detail="Adjust the search or status filter, or register products to start tracking stock." />}</div>}
        {filteredInventory.length > inventoryPageSize && <div className="catalogue-pagination"><span>Showing {(inventoryPage - 1) * inventoryPageSize + 1}–{Math.min(inventoryPage * inventoryPageSize, filteredInventory.length)} of {filteredInventory.length}{inventory.data?.items.length === 250 ? " (first 250 results)" : ""}</span><div><button className="small-action" disabled={inventoryPage <= 1} onClick={() => setInventoryPage((current) => Math.max(1, current - 1))}>Previous</button><span>Page {inventoryPage} of {inventoryPageCount}</span><button className="small-action" disabled={inventoryPage >= inventoryPageCount} onClick={() => setInventoryPage((current) => current + 1)}>Next</button></div></div>}
      </section>
      {canAdjust && <section className="panel operation-table-panel">
        <div className="panel-heading"><div><div className="eyebrow">DATE-SENSITIVE STOCK</div><h2>Expiring batches</h2></div><span className="pending-pill">Next 90 days · expired first</span></div>
        {expiry.isError && <ErrorBanner message={getErrorMessage(expiry.error)} onRetry={() => void expiry.refetch()} />}
        <div className="product-table-wrap"><table className="product-table"><thead><tr><th>PRODUCT</th><th>BATCH</th><th>EXPIRY DATE</th><th>QUANTITY</th><th>STATUS</th></tr></thead><tbody>
          {expiry.data?.map((batch) => {
            const expired = batch.expiryDate < dateInputValue(new Date());
            return <tr key={batch.id}><td><div className="report-product"><strong>{batch.name}</strong><small>{batch.sku}</small></div></td><td>{batch.batchCode ?? "—"}</td><td>{batch.expiryDate}</td><td>{Number(batch.quantity).toLocaleString("en-KE")} {batch.unit}</td><td><span className={`product-status ${expired ? "status-low" : ""}`}><i /> {expired ? "EXPIRED" : "EXPIRING"}</span></td></tr>;
          })}
        </tbody></table>{!expiry.isPending && !expiry.data?.length && <EmptyState title="No near-expiry stock" detail="Tracked batches expiring within 90 days will appear here." />}</div>
      </section>}
      {canAdjust && <section className="panel operation-form-panel">
        <div className="panel-heading"><div><div className="eyebrow">BRANCH OPERATIONS</div><h2>Inter-branch transfers</h2></div></div>
        {transferBranches.isError && <ErrorBanner message={getErrorMessage(transferBranches.error)} onRetry={() => void transferBranches.refetch()} />}
        {transferProducts.isError && <ErrorBanner message={getErrorMessage(transferProducts.error)} onRetry={() => void transferProducts.refetch()} />}
        {transferBranches.data?.length ? <form className="operation-form" onSubmit={(event) => { event.preventDefault(); setError(""); createTransfer.mutate(); }}>
          <label>Destination branch<select value={transferDestinationId} onChange={(event) => setTransferDestinationId(event.target.value)} required><option value="">Select branch</option>{transferBranches.data.map((branch) => <option value={branch.id} key={branch.id}>{branch.name} · {branch.code}</option>)}</select></label>
          <label>Notes<input value={transferNotes} onChange={(event) => setTransferNotes(event.target.value)} maxLength={500} placeholder="Optional transfer notes" /></label>
          {transferLines.map((item, index) => <div className="transfer-form-line" key={index}>
            <label>Product<select value={item.productId} onChange={(event) => setTransferLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, productId: event.target.value } : line))} required><option value="">Select product</option>{transferProducts.data?.map((product) => <option value={product.id} key={product.id}>{product.name} · {product.sku} · {Number(product.stock).toFixed(3)} available</option>)}</select></label>
            <label>Quantity<input type="number" min="0.001" step="0.001" value={item.quantity} onChange={(event) => setTransferLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, quantity: event.target.value } : line))} required /></label>
            {transferLines.length > 1 && <button className="small-action" type="button" onClick={() => setTransferLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}>Remove</button>}
          </div>)}
          <div className="transfer-form-actions">
            <button className="small-action" type="button" onClick={() => setTransferLines((current) => [...current, { productId: "", quantity: "1" }])} disabled={transferLines.length >= 100}>Add product</button>
            <button className="button button-dark" disabled={!transferCreateEnabled || createTransfer.isPending}>{createTransfer.isPending ? "Saving…" : "Create draft transfer"}</button>
          </div>
          <p className="operation-note">Stock moves only when the source branch dispatches. The destination branch records received quantities and any shortage.</p>
        </form> : !transferBranches.isPending && <EmptyState title="No destination branches" detail="Add another branch before creating an inter-branch transfer." />}
        {transfers.isError && <ErrorBanner message={getErrorMessage(transfers.error)} onRetry={() => void transfers.refetch()} />}
        <div className="product-table-wrap"><table className="product-table"><thead><tr><th>REFERENCE</th><th>FROM / TO</th><th>ITEMS</th><th>STATUS</th><th>CREATED</th><th>ACTION</th></tr></thead><tbody>
          {transfers.data?.map((transfer) => <tr key={transfer.id}>
            <td className="sku-cell">{transfer.reference}</td>
            <td>{transfer.sourceBranch} → {transfer.destinationBranch}</td>
            <td>{transfer.itemCount}{transfer.quantityDispatched ? ` · sent ${Number(transfer.quantityDispatched).toFixed(3)}` : ""}{transfer.quantityReceived ? ` · received ${Number(transfer.quantityReceived).toFixed(3)}` : ""}</td>
            <td><span className={`product-status ${transfer.status === "in_transit" ? "status-low" : ""}`}><i /> {transfer.status.replace("_", " ").toUpperCase()}</span></td>
            <td>{new Date(transfer.createdAt).toLocaleDateString("en-KE")}</td>
            <td className="row-actions">
              {transfer.status === "draft" && transfer.sourceBranchId === user.branchId && <button className="small-action" onClick={() => dispatchTransfer.mutate(transfer.id)} disabled={dispatchTransfer.isPending}>Dispatch</button>}
              {transfer.status === "in_transit" && transfer.destinationBranchId === user.branchId && <button className="small-action" onClick={() => { setSelectedTransferId(transfer.id); setReceivedQuantities({}); }}>Receive</button>}
              <button className="small-action" onClick={() => { setSelectedTransferId(transfer.id); setReceivedQuantities({}); }}>Details</button>
            </td>
          </tr>)}
        </tbody></table>{!transfers.isPending && !transfers.data?.length && <EmptyState title="No transfers yet" detail="Draft transfers will appear for both sending and receiving branches." />}</div>
        {selectedTransferId !== null && <div className="stock-count-editor">
          <div className="panel-heading"><div><div className="eyebrow">TRANSFER DETAILS</div><h2>{selectedTransfer.data?.reference ?? "Loading transfer…"}</h2></div><button className="small-action" onClick={() => setSelectedTransferId(null)}>Close</button></div>
          {selectedTransfer.isError && <ErrorBanner message={getErrorMessage(selectedTransfer.error)} onRetry={() => void selectedTransfer.refetch()} />}
          {selectedTransfer.data && <>
            <p className="operation-note">{selectedTransfer.data.sourceBranch} → {selectedTransfer.data.destinationBranch}{selectedTransfer.data.notes ? ` · ${selectedTransfer.data.notes}` : ""}</p>
            <div className="product-table-wrap"><table className="product-table"><thead><tr><th>PRODUCT</th><th>REQUESTED / SENT</th><th>RECEIVED</th>{selectedTransfer.data.status === "in_transit" && selectedTransfer.data.destinationBranchId === user.branchId && <th>RECEIVING COUNT</th>}</tr></thead><tbody>
              {selectedTransfer.data.items.map((item) => <tr key={item.productId}>
                <td><div className="report-product"><strong>{item.name}</strong><small>{item.sku} · {item.unit}</small></div></td>
                <td>{Number(item.quantityRequested).toFixed(3)} / {item.quantityDispatched === null ? "—" : Number(item.quantityDispatched).toFixed(3)}</td>
                <td>{item.quantityReceived === null ? "—" : <>{Number(item.quantityReceived).toFixed(3)}{item.quantityVariance && Number(item.quantityVariance) !== 0 ? ` (${Number(item.quantityVariance).toFixed(3)})` : ""}</>}</td>
                {selectedTransfer.data.status === "in_transit" && selectedTransfer.data.destinationBranchId === user.branchId && <td><input aria-label={`Received ${item.name}`} type="number" min="0" max={item.quantityDispatched ?? undefined} step="0.001" value={receivedQuantities[item.productId] ?? item.quantityDispatched ?? ""} onChange={(event) => setReceivedQuantities((current) => ({ ...current, [item.productId]: event.target.value }))} /></td>}
              </tr>)}
            </tbody></table></div>
            {selectedTransfer.data.status === "in_transit" && selectedTransfer.data.destinationBranchId === user.branchId && <button className="button button-dark" onClick={() => receiveTransfer.mutate()} disabled={!transferReceiveEnabled || receiveTransfer.isPending}>{receiveTransfer.isPending ? "Recording receipt…" : "Confirm receipt"}</button>}
          </>}
        </div>}
      </section>}
      {canAdjust && <section className="panel operation-table-panel">
        <div className="panel-heading"><div><div className="eyebrow">PHYSICAL INVENTORY</div><h2>Stock counts</h2></div><button className="button button-dark" onClick={() => startTake.mutate()} disabled={startTake.isPending}>{startTake.isPending ? "Starting…" : "Start full count"}</button></div>
        {stockTakes.isError && <ErrorBanner message={getErrorMessage(stockTakes.error)} onRetry={() => void stockTakes.refetch()} />}
        <div className="product-table-wrap"><table className="product-table"><thead><tr><th>REFERENCE</th><th>COUNT</th><th>STATUS</th><th>STARTED</th><th>ACTION</th></tr></thead><tbody>
          {stockTakes.data?.map((take) => <tr key={take.id}><td className="sku-cell">{take.reference}<br />{take.title}</td><td>{take.countedItems} / {take.totalItems}</td><td>{take.status.toUpperCase()}</td><td>{new Date(take.createdAt).toLocaleDateString("en-KE")}</td><td>{take.status === "draft" && <button className="small-action" onClick={() => { setSelectedTakeId(take.id); setCounts({}); }}>Continue count</button>}</td></tr>)}
        </tbody></table>{!stockTakes.isPending && !stockTakes.data?.length && <EmptyState title="No stock counts yet" detail="Start a full count to reconcile physical quantities with the inventory ledger." />}</div>
        {selectedTakeId !== null && <div className="stock-count-editor">
          <div className="panel-heading"><div><div className="eyebrow">DRAFT STOCK COUNT</div><h2>{selectedTake.data?.title ?? "Loading count…"}</h2></div><button className="small-action" onClick={() => setSelectedTakeId(null)}>Close</button></div>
          {selectedTake.isError && <ErrorBanner message={getErrorMessage(selectedTake.error)} onRetry={() => void selectedTake.refetch()} />}
          {selectedTake.data && <div className="product-table-wrap"><table className="product-table"><thead><tr><th>PRODUCT</th><th>SYSTEM QTY</th><th>PHYSICAL COUNT</th></tr></thead><tbody>
            {selectedTake.data.items.map((item) => <tr key={item.productId}><td><div className="report-product"><strong>{item.name}</strong><small>{item.sku} · {item.unit}</small></div></td><td>{Number(item.expectedQuantity).toLocaleString("en-KE")}</td><td><input aria-label={`Count ${item.name}`} type="number" min="0" step="0.001" value={counts[item.productId] ?? item.countedQuantity ?? ""} onChange={(event) => setCounts((current) => ({ ...current, [item.productId]: event.target.value }))} /></td></tr>)}
          </tbody></table></div>}
          <button className="button button-dark" onClick={() => completeTake.mutate()} disabled={!takeCompleteEnabled || completeTake.isPending}>{completeTake.isPending ? "Reconciling…" : "Complete count and reconcile stock"}</button>
        </div>}
      </section>}
      <section className="panel operation-table-panel"><div className="panel-heading"><div><div className="eyebrow">AUDIT TRAIL</div><h2>Recent movements</h2></div></div>
        <div className="product-table-wrap"><table className="product-table"><thead><tr><th>PRODUCT</th><th>MOVEMENT</th><th>QUANTITY</th><th>REFERENCE</th><th>RECORDED BY</th><th>DATE</th></tr></thead><tbody>{inventory.data?.movements.map((item) => <tr key={item.id}><td><div className="table-product-name"><div><strong>{item.product}</strong><small>{item.sku}</small></div></div></td><td className="sku-cell">{item.type.replace("_", " ").toUpperCase()}</td><td className="stock-cell">{Number(item.quantity).toFixed(3)}</td><td>{item.reference ?? "—"}</td><td>{item.createdBy}</td><td>{new Date(item.createdAt).toLocaleString("en-KE")}</td></tr>)}</tbody></table>{!inventory.data?.movements.length && <EmptyState title="No stock movements" detail="Receipts and adjustments will be recorded here." />}</div>
      </section>
    </section>
  );
}

function SuppliersPage({ user }: { user: User }) {
  const query = useQueryClient();
  const canManage = user.roles.some((role) => ["admin", "manager", "procurement_officer"].includes(role));
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", contactName: "", email: "", phone: "", taxPin: "", address: "" });
  const suppliers = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => (await api.get<{ suppliers: Array<{ id: number; name: string; contactName: string | null; email: string | null; phone: string | null; taxPin: string | null }> }>("/suppliers")).data.suppliers,
  });
  const create = useMutation({
    mutationFn: () => api.post("/suppliers", form),
    onSuccess: () => { setForm({ name: "", contactName: "", email: "", phone: "", taxPin: "", address: "" }); setError(""); void query.invalidateQueries({ queryKey: ["suppliers"] }); },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  return <section className="page-content operations-page"><PageHeader eyebrow="SUPPLIER DIRECTORY" title="Suppliers" detail="Keep supplier contacts ready for your next purchase order." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
    {canManage && <section className="panel operation-form-panel"><div className="panel-heading"><div><div className="eyebrow">NEW CONTACT</div><h2>Register a supplier</h2></div></div>
      <form className="operation-form supplier-form" onSubmit={(event) => { event.preventDefault(); setError(""); create.mutate(); }}>
        <label>Business name<input required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Contact person<input value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} /></label>
        <label>Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label>Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        <label>KRA PIN<input value={form.taxPin} onChange={(event) => setForm({ ...form, taxPin: event.target.value })} /></label>
        <label>Address<input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
        <button className="button button-dark" disabled={create.isPending}>{create.isPending ? "Saving…" : "Save supplier"}</button>
      </form>
    </section>}
    <section className="panel operation-table-panel"><div className="panel-heading"><div><div className="eyebrow">ACTIVE CONTACTS</div><h2>Supplier list</h2></div></div>{suppliers.isError && <ErrorBanner message={getErrorMessage(suppliers.error)} onRetry={() => void suppliers.refetch()} />}
      <div className="product-table-wrap"><table className="product-table"><thead><tr><th>SUPPLIER</th><th>CONTACT</th><th>EMAIL</th><th>PHONE</th><th>KRA PIN</th></tr></thead><tbody>{suppliers.data?.map((item) => <tr key={item.id}><td className="stock-cell">{item.name}</td><td>{item.contactName ?? "—"}</td><td>{item.email ?? "—"}</td><td>{item.phone ?? "—"}</td><td>{item.taxPin ?? "—"}</td></tr>)}</tbody></table>{!suppliers.isPending && !suppliers.data?.length && <EmptyState title="No suppliers registered" detail="Add supplier details to prepare purchase orders." />}</div>
    </section>
  </section>;
}

function PurchasesPage({ user }: { user: User }) {
  const query = useQueryClient();
  const canCreate = user.roles.some((role) => ["admin", "manager", "procurement_officer"].includes(role));
  const [error, setError] = useState("");
  const [form, setForm] = useState({ supplierId: "", productId: "", quantity: "1", unitCost: "0.00", notes: "" });
  const [receiveBatch, setReceiveBatch] = useState({ batchCode: "", expiryDate: "" });
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: async () => (await api.get<{ suppliers: Array<{ id: number; name: string }> }>("/suppliers")).data.suppliers });
  const products = useQuery({ queryKey: ["products", "purchase-selector"], queryFn: async () => (await api.get<{ products: Product[] }>("/products")).data.products });
  const orders = useQuery({ queryKey: ["purchase-orders"], queryFn: async () => (await api.get<{ orders: Array<{
    id: number; orderNumber: string; status: string; supplier: string; createdAt: string; itemCount: number;
    orderedQuantity: string; receivedQuantity: string;
  }> }>("/purchase-orders")).data.orders });
  const create = useMutation({
    mutationFn: () => api.post("/purchase-orders", {
      supplierId: Number(form.supplierId), notes: form.notes,
      items: [{ productId: Number(form.productId), quantity: form.quantity, unitCost: form.unitCost }],
    }),
    onSuccess: () => { setError(""); setForm({ ...form, notes: "" }); void query.invalidateQueries({ queryKey: ["purchase-orders"] }); },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const approve = useMutation({
    mutationFn: (id: number) => api.post(`/purchase-orders/${id}/approve`),
    onSuccess: () => void query.invalidateQueries({ queryKey: ["purchase-orders"] }),
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const canReceive = user.roles.some((role) => ["admin", "manager", "procurement_officer", "inventory_manager"].includes(role));
  const receive = useMutation({
    mutationFn: async (id: number) => {
      const { data } = await api.get<{ items: Array<{ id: number; quantityOrdered: string; quantityReceived: string }> }>(`/purchase-orders/${id}`);
      const items = data.items.map((item) => ({
        purchaseOrderItemId: item.id,
        quantity: (Number(item.quantityOrdered) - Number(item.quantityReceived)).toFixed(3),
        batchCode: receiveBatch.batchCode || undefined,
        expiryDate: receiveBatch.expiryDate || undefined,
      })).filter((item) => Number(item.quantity) > 0);
      return api.post(`/purchase-orders/${id}/receive`, { items });
    },
    onSuccess: () => {
      setError("");
      void query.invalidateQueries({ queryKey: ["purchase-orders"] });
      void query.invalidateQueries({ queryKey: ["inventory"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  return <section className="page-content operations-page"><PageHeader eyebrow="PROCUREMENT" title="Purchasing" detail="Create orders, approve them, and receive goods into branch stock." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
  {(suppliers.isError || products.isError || orders.isError) && <ErrorBanner message={getErrorMessage(suppliers.error ?? products.error ?? orders.error)} onRetry={() => { void suppliers.refetch(); void products.refetch(); void orders.refetch(); }} />}
    {canCreate && <section className="panel operation-form-panel"><div className="panel-heading"><div><div className="eyebrow">PURCHASE REQUEST</div><h2>Create a purchase order</h2></div><span className="pending-pill">Requires manager approval</span></div>
      <form className="operation-form" onSubmit={(event) => { event.preventDefault(); setError(""); create.mutate(); }}>
        <label>Supplier<select required value={form.supplierId} onChange={(event) => setForm({ ...form, supplierId: event.target.value })}><option value="">Select supplier</option>{suppliers.data?.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
        <label>Product<select required value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}><option value="">Select product</option>{products.data?.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></label>
        <label>Quantity<input required inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>
        <label>Unit cost (KES)<input required inputMode="decimal" value={form.unitCost} onChange={(event) => setForm({ ...form, unitCost: event.target.value })} /></label>
        <label>Notes<input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Optional delivery notes" /></label>
        <button className="button button-dark" disabled={create.isPending || !form.supplierId || !form.productId}>{create.isPending ? "Creating…" : "Create draft order"}</button>
      </form>
    </section>}
    <section className="panel operation-table-panel"><div className="panel-heading"><div><div className="eyebrow">ORDER TRACKING</div><h2>Purchase orders</h2></div></div>
      {canReceive && <div className="receive-batch-fields">
        <span>Optional batch details applied to a full-order receipt:</span>
        <label>Batch / lot code<input value={receiveBatch.batchCode} onChange={(event) => setReceiveBatch({ ...receiveBatch, batchCode: event.target.value })} placeholder="Optional" /></label>
        <label>Expiry date<input type="date" value={receiveBatch.expiryDate} onChange={(event) => setReceiveBatch({ ...receiveBatch, expiryDate: event.target.value })} /></label>
      </div>}
      {orders.isPending ? <LoadingRows /> : <div className="product-table-wrap"><table className="product-table"><thead><tr><th>ORDER</th><th>SUPPLIER</th><th>ITEMS</th><th>QUANTITY</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{orders.data?.map((order) => <tr key={order.id}><td className="sku-cell">{order.orderNumber}</td><td className="stock-cell">{order.supplier}</td><td>{order.itemCount}</td><td>{Number(order.receivedQuantity).toFixed(2)} / {Number(order.orderedQuantity).toFixed(2)}</td><td><span className={`product-status ${order.status === "received" ? "" : "status-low"}`}><i /> {order.status.replace("_", " ").toUpperCase()}</span></td>      <td className="row-actions">{order.status === "draft" && user.roles.some((role) => ["admin", "manager"].includes(role)) && <button className="small-action" onClick={() => approve.mutate(order.id)} disabled={approve.isPending}>Approve</button>}{canReceive && ["ordered", "partially_received"].includes(order.status) && <button className="small-action" onClick={() => receive.mutate(order.id)} disabled={receive.isPending}>Receive remaining</button>}</td></tr>)}</tbody></table>{!orders.data?.length && <EmptyState title="No purchase orders" detail="Create a draft order to start procurement." />}</div>}
    </section>
  </section>;
}

function StaffPage({ user }: { user: User }) {
  const query = useQueryClient();
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [branchId, setBranchId] = useState(String(user.branchId));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [activityId, setActivityId] = useState<number | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [activeTab, setActiveTab] = useState<"users" | "roles">("users");
  const [roleName, setRoleName] = useState("cashier");
  const [roleDraft, setRoleDraft] = useState<Record<string, boolean>>({});
  const emptyForm = () => ({
    name: "", email: "", username: "", password: "", role: "cashier",
    branchId: String(user.branchId), departmentId: "", employeeNumber: "",
    jobTitle: "", phone: "", hiredAt: "", defaultLanding: "",
    isActive: true, mustChangePassword: true,
  });
  const [form, setForm] = useState(emptyForm);
  const [moduleSelections, setModuleSelections] = useState<Record<string, boolean | null>>({});
  type Module = { id: string; name: string; route: string; sortOrder: number };
  type Member = {
    id: number; name: string; email: string; username: string; isActive: boolean; createdAt: string;
    department: string | null; employeeNumber: string | null; jobTitle: string | null; phone: string | null;
    hiredAt: string | null; roles: string[]; lastLogin: string | null; defaultLanding: string | null;
    branchId: number; branch: string; permissionOverrides: Array<{ moduleId: string; allowed: boolean }>;
  };
  const staff = useQuery({
    queryKey: ["staff", branchId, search],
    queryFn: async () => (await api.get<{ staff: Array<{
      id: number; name: string; email: string; username: string; isActive: boolean; createdAt: string;
      department: string | null; employeeNumber: string | null; jobTitle: string | null; phone: string | null;
      hiredAt: string | null; roles: string[]; lastLogin: string | null; defaultLanding: string | null;
      branchId: number; branch: string; permissionOverrides: Array<{ moduleId: string; allowed: boolean }>;
    }> }>("/staff", { params: { search, branchId: Number(branchId) } })).data.staff as Member[],
  });
  const departments = useQuery({
    queryKey: ["staff-departments"],
    queryFn: async () => (await api.get<{ departments: Array<{ id: number; name: string }> }>("/staff/departments")).data.departments,
  });
  const modules = useQuery({
    queryKey: ["access-modules"],
    queryFn: async () => (await api.get<{ modules: Module[] }>("/access/modules")).data.modules,
  });
  const branches = useQuery({
    queryKey: ["staff-branches"],
    queryFn: async () => (await api.get<{ branches: Array<{ id: number; name: string; code: string }> }>("/staff/branches")).data.branches,
  });
  const roles = useQuery({
    queryKey: ["access-roles"],
    queryFn: async () => (await api.get<{ roles: Array<{
      id: number; name: string; permissions: Array<{ moduleId: string; name: string; route: string; allowed: boolean }>;
    }> }>("/access/roles")).data.roles,
  });
  const roleDefaults = roles.data?.find((role) => role.name === form.role)?.permissions ?? [];
  const rolePermissions = roles.data?.find((role) => role.name === roleName)?.permissions ?? [];
  const activity = useQuery({
    queryKey: ["staff-activity", activityId],
    enabled: activityId !== null,
    queryFn: async () => (await api.get<{
      logins: Array<{ success: boolean; identifier: string | null; ipAddress: string | null; userAgent: string | null; createdAt: string }>;
      activity: Array<{ action: string; entityType: string | null; entityId: string | null; details: string | null; createdAt: string }>;
    }>(`/staff/${activityId}/activity`)).data,
  });
  const refresh = () => {
    void query.invalidateQueries({ queryKey: ["staff"] });
    void query.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const payload = {
        name: form.name, email: form.email, username: form.username, role: form.role,
        branchId: Number(form.branchId), departmentId: form.departmentId ? Number(form.departmentId) : null,
        employeeNumber: form.employeeNumber || null, jobTitle: form.jobTitle || "",
        phone: form.phone || "", hiredAt: form.hiredAt || null,
        defaultLanding: form.defaultLanding || null, isActive: form.isActive,
        modulePermissions: Object.entries(moduleSelections).map(([moduleId, allowed]) => ({ moduleId, allowed })),
      };
      if (editingId) {
        await api.put(`/staff/${editingId}`, payload);
      } else {
        await api.post("/staff", { ...payload, password: form.password, mustChangePassword: form.mustChangePassword });
      }
    },
    onSuccess: () => {
      setForm(emptyForm());
      setModuleSelections({});
      setEditingId(null);
      setError("");
      refresh();
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const setStatus = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => api.patch(`/staff/${id}/status`, { isActive }),
    onSuccess: () => { setError(""); refresh(); },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const reset = useMutation({
    mutationFn: () => api.post(`/staff/${resetId}/password-reset`, { password: resetPassword }),
    onSuccess: () => { setResetId(null); setResetPassword(""); setError(""); },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const saveRole = useMutation({
    mutationFn: () => api.put(`/access/roles/${roleName}`, {
      permissions: rolePermissions.map((permission) => ({
        moduleId: permission.moduleId,
        allowed: roleDraft[permission.moduleId] ?? permission.allowed,
      })),
    }),
    onSuccess: () => {
      setError("");
      void query.invalidateQueries({ queryKey: ["access-roles"] });
      void query.invalidateQueries({ queryKey: ["staff"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const beginEdit = (member: Member) => {
    setEditingId(member.id);
    setForm({
      name: member.name, email: member.email, username: member.username, password: "",
      role: member.roles[0] ?? "cashier", branchId: String(member.branchId),
      departmentId: "", employeeNumber: member.employeeNumber ?? "",
      jobTitle: member.jobTitle ?? "", phone: member.phone ?? "", hiredAt: member.hiredAt ?? "",
      defaultLanding: member.defaultLanding ?? "", isActive: member.isActive, mustChangePassword: false,
    });
    setModuleSelections(Object.fromEntries(member.permissionOverrides.map(({ moduleId, allowed }) => [moduleId, allowed])));
    setError("");
  };
  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm());
    setModuleSelections({});
  };
  const currentRole = roles.data?.find((role) => role.name === form.role);
  const availableLandings = (modules.data ?? []).filter((module) => {
    if (module.id === "permissions" || module.id.startsWith("transaction_")) return false;
    const assigned = moduleSelections[module.id] ?? currentRole?.permissions.find((permission) => permission.moduleId === module.id)?.allowed;
    return Boolean(assigned);
  });
  const modulesLoading = modules.isPending || roles.isPending;
  return <section className="page-content operations-page">
    <PageHeader eyebrow="ACCESS CONTROL" title="User management" detail="Create staff accounts, assign roles, and control access to each workspace." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
    {(staff.isError || departments.isError || modules.isError || branches.isError || roles.isError)
      && <ErrorBanner message={getErrorMessage(staff.error ?? departments.error ?? modules.error ?? branches.error ?? roles.error)} onRetry={() => {
        void staff.refetch(); void departments.refetch(); void modules.refetch(); void branches.refetch(); void roles.refetch();
      }} />}
    <div className="staff-tabs" role="tablist">
      <button className={activeTab === "users" ? "active" : ""} onClick={() => setActiveTab("users")}>Users and access</button>
      <button className={activeTab === "roles" ? "active" : ""} onClick={() => setActiveTab("roles")}>Role defaults</button>
    </div>
    {activeTab === "users" && <section className="panel operation-form-panel user-management-form">
      <div className="panel-heading"><div><div className="eyebrow">{editingId ? "EDIT ACCOUNT" : "STAFF ONBOARDING"}</div><h2>{editingId ? "Update user account" : "Create a user account"}</h2></div>
        {editingId && <button className="small-action" type="button" onClick={cancelEdit}>Cancel edit</button>}</div>
      <form className="operation-form staff-form" onSubmit={(event) => { event.preventDefault(); setError(""); save.mutate(); }}>
        <label>Full name<input required minLength={2} maxLength={150} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Work email<input type="email" required maxLength={254} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label>Username<input required minLength={4} maxLength={100} pattern="[A-Za-z0-9._-]+" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
        {!editingId && <label>Temporary password<input type="password" autoComplete="new-password" minLength={4} maxLength={200} required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><small>At least 4 characters. The employee must change it after signing in.</small></label>}
        <label>Role<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, defaultLanding: "" })}>{roles.data?.map((role) => <option key={role.name} value={role.name}>{role.name.replaceAll("_", " ")}</option>)}</select></label>
        <label>Branch<select value={form.branchId} onChange={(event) => setForm({ ...form, branchId: event.target.value })}>{branches.data?.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>)}</select></label>
        <label>Department<select value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}><option value="">Unassigned</option>{departments.data?.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
        <label>Employee number<input maxLength={50} value={form.employeeNumber} onChange={(event) => setForm({ ...form, employeeNumber: event.target.value })} /></label>
        <label>Job title<input maxLength={120} value={form.jobTitle} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} /></label>
        <label>Phone<input maxLength={40} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        <label>Hire date<input type="date" value={form.hiredAt} onChange={(event) => setForm({ ...form, hiredAt: event.target.value })} /></label>
        <label>Default landing page<select value={form.defaultLanding} onChange={(event) => setForm({ ...form, defaultLanding: event.target.value })}><option value="">Use role default</option>{availableLandings.map((module) => <option key={`${module.id}-${module.route}`} value={module.route}>{module.name}</option>)}</select></label>
        {!editingId && <label className="staff-checkbox"><input type="checkbox" checked={form.mustChangePassword} onChange={(event) => setForm({ ...form, mustChangePassword: event.target.checked })} /> Require password change at first sign-in</label>}
        <label className="staff-checkbox"><input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} /> Account active</label>
        <div className="user-permission-editor">
          <div className="panel-heading"><div><div className="eyebrow">MODULE ACCESS</div><h3>Permissions for this user</h3></div><small>Inherit role, allow, or deny access.</small></div>
          {modulesLoading ? <LoadingRows /> : <div className="permission-matrix">
            {(modules.data ?? []).map((module) => {
              const selected = moduleSelections[module.id] ?? null;
              const fallback = roleDefaults.find((permission) => permission.moduleId === module.id)?.allowed ?? false;
              return <label key={module.id}><span>{module.name}<small>{module.route}</small></span><select value={selected === null ? "" : selected ? "allow" : "deny"} onChange={(event) => setModuleSelections({
                ...moduleSelections,
                [module.id]: event.target.value === "" ? null : event.target.value === "allow",
              })}>
                <option value="">Role default ({fallback ? "allow" : "deny"})</option><option value="allow">Allow</option><option value="deny">Deny</option>
              </select></label>;
            })}
          </div>}
        </div>
        <button className="button button-dark" disabled={save.isPending || modulesLoading || branches.isPending}>
          {save.isPending ? "Saving…" : editingId ? "Save user changes" : "Create user account"}
        </button>
      </form>
    </section>}
    {activeTab === "users" && <section className="panel operation-table-panel">
      <div className="products-toolbar"><div><div className="eyebrow">BRANCH DIRECTORY</div><h2>Staff accounts</h2></div><div className="staff-table-controls">
        <select value={branchId} onChange={(event) => setBranchId(event.target.value)} aria-label="Filter by branch">{branches.data?.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>
        <label className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, username, email or number" /></label>
      </div></div>
      {staff.isPending ? <LoadingRows /> : <div className="product-table-wrap"><table className="product-table"><thead><tr><th>EMPLOYEE</th><th>USERNAME</th><th>ROLE</th><th>BRANCH / DEPARTMENT</th><th>LAST SIGN-IN</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>
        {staff.data?.map((member) => <tr key={member.id}>
          <td><div className="table-product-name"><span>{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}{member.employeeNumber ? ` · ${member.employeeNumber}` : ""}</strong><small>{member.email}{member.jobTitle ? ` · ${member.jobTitle}` : ""}</small></div></div></td>
          <td className="sku-cell">{member.username}</td>
          <td className="sku-cell">{member.roles.map((role) => role.replaceAll("_", " ").toUpperCase()).join(", ") || "NO ROLE"}</td>
          <td>{member.branch} / {member.department ?? "Unassigned"}</td>
          <td>{member.lastLogin ? new Date(member.lastLogin).toLocaleString("en-KE") : "Never"}</td>
          <td><span className={`product-status ${member.isActive ? "" : "status-low"}`}><i /> {member.isActive ? "ACTIVE" : "INACTIVE"}</span></td>
          <td className="row-actions">
            <button className="small-action" onClick={() => beginEdit(member)}>Edit</button>
            <button className="small-action" onClick={() => { setActivityId(activityId === member.id ? null : member.id); void query.invalidateQueries({ queryKey: ["staff-activity", member.id] }); }}>Activity</button>
            {member.id !== user.id && <button className={`small-action ${member.isActive ? "reject-action" : ""}`} onClick={() => setStatus.mutate({ id: member.id, isActive: !member.isActive })} disabled={setStatus.isPending}>{member.isActive ? "Deactivate" : "Activate"}</button>}
            {member.id !== user.id && <button className="small-action" onClick={() => { setResetId(resetId === member.id ? null : member.id); setResetPassword(""); }}>Reset password</button>}
          </td>
        </tr>)}
      </tbody></table>{!staff.data?.length && <EmptyState title="No team members found" detail="Create staff accounts for this branch or refine your search." />}</div>}
      {resetId !== null && <form className="staff-reset-form" onSubmit={(event) => { event.preventDefault(); setError(""); reset.mutate(); }}>
        <strong>Set a temporary password</strong><input type="password" minLength={4} maxLength={200} required autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="At least 4 characters" />
        <button className="small-action" disabled={reset.isPending}>{reset.isPending ? "Resetting…" : "Reset and require change"}</button>
      </form>}
      {activityId !== null && <div className="staff-activity-panel">
        <div className="panel-heading"><div><div className="eyebrow">ACCOUNT HISTORY</div><h3>{staff.data?.find((member) => member.id === activityId)?.name}</h3></div><button className="small-action" onClick={() => setActivityId(null)}>Close</button></div>
        {activity.isPending ? <LoadingRows /> : activity.isError ? <ErrorBanner message={getErrorMessage(activity.error)} onRetry={() => void activity.refetch()} /> : <div className="staff-activity-grid">
          <div><strong>Login history</strong>{activity.data?.logins.map((entry, index) => <p key={`${entry.createdAt}-${index}`}><span className={entry.success ? "activity-success" : "activity-failed"}>{entry.success ? "Success" : "Failed"}</span> · {entry.identifier ?? "unknown"} · {new Date(entry.createdAt).toLocaleString("en-KE")} {entry.ipAddress ? `· ${entry.ipAddress}` : ""}</p>)}</div>
          <div><strong>Recent activity</strong>{activity.data?.activity.map((entry, index) => <p key={`${entry.createdAt}-${index}`}>{entry.action} · {new Date(entry.createdAt).toLocaleString("en-KE")}</p>)}</div>
        </div>}
      </div>}
    </section>}
    {activeTab === "roles" && <section className="panel operation-table-panel role-management-panel">
      <div className="products-toolbar"><div><div className="eyebrow">ROLE-BASED ACCESS</div><h2>Default role permissions</h2></div>
        <select value={roleName} onChange={(event) => { setRoleName(event.target.value); setRoleDraft({}); }} aria-label="Select role">{roles.data?.map((role) => <option key={role.name} value={role.name}>{role.name.replaceAll("_", " ")}</option>)}</select>
      </div>
      <p className="role-management-note">User-specific allow or deny settings override these defaults. Transaction History access is granted per user, not by role. Administrator access cannot be reduced here.</p>
      {roles.isPending ? <LoadingRows /> : <div className="permission-matrix role-matrix">
        {rolePermissions.map((permission) => <label key={permission.moduleId}>
          <span>{permission.name}<small>{permission.route}</small></span>
          <input type="checkbox" checked={roleDraft[permission.moduleId] ?? permission.allowed} disabled={roleName === "admin" || permission.moduleId === "sales" || permission.moduleId.startsWith("transaction_")} onChange={(event) => setRoleDraft({ ...roleDraft, [permission.moduleId]: event.target.checked })} />
        </label>)}
      </div>}
      <button className="button button-dark" disabled={saveRole.isPending || roleName === "admin" || roles.isPending} onClick={() => saveRole.mutate()}>
        {roleName === "admin" ? "Administrator defaults are locked" : saveRole.isPending ? "Saving…" : "Save role permissions"}
      </button>
    </section>}
  </section>;
}

function CustomersPage({ user }: { user: User }) {
  const query = useQueryClient();
  const canCreate = user.roles.some((role) => ["admin", "manager", "cashier", "accountant"].includes(role));
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "" });
  const customers = useQuery({ queryKey: ["customers", search], queryFn: async () => (await api.get<{ customers: Array<{
    id: number; name: string; phone: string | null; email: string | null; salesCount: number; lifetimeValue: string;
  }> }>("/customers", { params: { search } })).data.customers });
  const create = useMutation({
    mutationFn: () => api.post("/customers", form),
    onSuccess: () => { setForm({ name: "", phone: "", email: "", address: "" }); setError(""); void query.invalidateQueries({ queryKey: ["customers"] }); },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  return <section className="page-content operations-page"><PageHeader eyebrow="CUSTOMER RELATIONSHIPS" title="Customers" detail="Maintain customer contacts and view their completed purchase history." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
    {customers.isError && <ErrorBanner message={getErrorMessage(customers.error)} onRetry={() => void customers.refetch()} />}
    {canCreate && <section className="panel operation-form-panel"><div className="panel-heading"><div><div className="eyebrow">NEW CUSTOMER</div><h2>Add a customer</h2></div></div>
      <form className="operation-form" onSubmit={(event) => { event.preventDefault(); setError(""); create.mutate(); }}>
        <label>Customer name<input required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        <label>Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label>Address<input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
        <button className="button button-dark" disabled={create.isPending}>{create.isPending ? "Saving…" : "Save customer"}</button>
      </form>
    </section>}
    <section className="panel operation-table-panel"><div className="products-toolbar"><div><div className="eyebrow">CUSTOMER DIRECTORY</div><h2>Customers</h2></div><label className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or phone" /></label></div>
      <div className="product-table-wrap"><table className="product-table"><thead><tr><th>CUSTOMER</th><th>PHONE</th><th>EMAIL</th><th>SALES</th><th>LIFETIME SALES</th></tr></thead><tbody>{customers.data?.map((customer) => <tr key={customer.id}><td className="stock-cell">{customer.name}</td><td>{customer.phone ?? "—"}</td><td>{customer.email ?? "—"}</td><td>{customer.salesCount}</td><td className="price-cell">{money(customer.lifetimeValue)}</td></tr>)}</tbody></table>{!customers.isPending && !customers.data?.length && <EmptyState title="No customers found" detail="Register a customer or search by name or phone." />}</div>
    </section>
  </section>;
}

function ShiftsPage({ user }: { user: User }) {
  const query = useQueryClient();
  const [openingCash, setOpeningCash] = useState("0.00");
  const [counterNumber, setCounterNumber] = useState("");
  const [actualCash, setActualCash] = useState("");
  const [movement, setMovement] = useState({ type: "deposit", amount: "", description: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useQuery({ queryKey: ["active-shift"], queryFn: async () => (await api.get<{ shift: { id: number; openingCash: string; openedAt: string; counterNumber: string | null } | null }>("/shifts/active")).data.shift });
  const refresh = () => { void query.invalidateQueries({ queryKey: ["active-shift"] }); void query.invalidateQueries({ queryKey: ["dashboard"] }); };
  const open = useMutation({ mutationFn: () => api.post("/shifts/open", { openingCash, counterNumber }), onSuccess: () => { setError(""); setNotice(""); refresh(); }, onError: (reason) => setError(getErrorMessage(reason)) });
  const cashMove = useMutation({ mutationFn: () => api.post("/shifts/cash-movements", movement), onSuccess: () => { setMovement({ ...movement, amount: "", description: "" }); setError(""); }, onError: (reason) => setError(getErrorMessage(reason)) });
  const close = useMutation({ mutationFn: () => api.post("/shifts/close", { actualCash }), onSuccess: (response) => { const result = response.data as { expected: string; variance: string }; setNotice(`Shift closed. Expected ${money(result.expected)}; variance ${money(result.variance)}.`); setError(""); setActualCash(""); refresh(); }, onError: (reason) => setError(getErrorMessage(reason)) });
  const canOperate = user.roles.some((role) => ["admin", "manager", "cashier"].includes(role));
  return <section className="page-content operations-page"><PageHeader eyebrow="CASH CONTROL" title="Cashier shifts" detail="Open the drawer, record cash movements, and reconcile before closing." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
    {active.isError && <ErrorBanner message={getErrorMessage(active.error)} onRetry={() => void active.refetch()} />}
    {notice && <div role="status" className="success-banner"><span>{notice}</span><button onClick={() => setNotice("")}>Dismiss</button></div>}
    <section className="panel shift-card">
      <div className="panel-heading"><div><div className="eyebrow">CURRENT REGISTER</div><h2>{active.data ? "Shift in progress" : "No active shift"}</h2></div><span className={`product-status ${active.data ? "" : "status-low"}`}><i /> {active.data ? "OPEN" : "CLOSED"}</span></div>
      {active.data ? <div className="shift-detail">
        <div><small>OPENING CASH</small><strong>{money(active.data.openingCash)}</strong></div>
        <div><small>OPENED</small><strong>{new Date(active.data.openedAt).toLocaleString("en-KE")}</strong></div>
        <div><small>COUNTER / TILL</small><strong>{active.data.counterNumber || "Not assigned"}</strong></div>
        {canOperate && <form className="inline-form" onSubmit={(event) => { event.preventDefault(); close.mutate(); }}><label>Actual cash in drawer<input required inputMode="decimal" value={actualCash} onChange={(event) => setActualCash(event.target.value)} placeholder="Count drawer and enter amount" /></label><button className="button button-dark" disabled={close.isPending}>{close.isPending ? "Reconciling…" : "Reconcile & close shift"}</button></form>}
      </div> : canOperate && <form className="operation-form" onSubmit={(event) => { event.preventDefault(); open.mutate(); }}><label>Opening float (KES)<input required inputMode="decimal" value={openingCash} onChange={(event) => setOpeningCash(event.target.value)} /></label><label>Counter / till number<input maxLength={40} value={counterNumber} onChange={(event) => setCounterNumber(event.target.value)} placeholder="Optional" /></label><button className="button button-dark" disabled={open.isPending}>{open.isPending ? "Opening…" : "Open cashier shift"}</button></form>}
    </section>
    {active.data && <section className="panel operation-form-panel"><div className="panel-heading"><div><div className="eyebrow">DRAWER ACTIVITY</div><h2>Record cash movement</h2></div></div><form className="operation-form" onSubmit={(event) => { event.preventDefault(); cashMove.mutate(); }}>
      <label>Movement<select value={movement.type} onChange={(event) => setMovement({ ...movement, type: event.target.value })}><option value="deposit">Cash in</option><option value="withdrawal">Cash out</option></select></label>
      <label>Amount<input required inputMode="decimal" value={movement.amount} onChange={(event) => setMovement({ ...movement, amount: event.target.value })} /></label>
      <label>Reason<input required minLength={3} value={movement.description} onChange={(event) => setMovement({ ...movement, description: event.target.value })} /></label>
      <button className="button button-dark" disabled={cashMove.isPending}>{cashMove.isPending ? "Recording…" : "Record movement"}</button>
    </form></section>}
  </section>;
}

function ExpensesPage({ user }: { user: User }) {
  const query = useQueryClient();
  const canCreate = user.roles.some((role) => ["admin", "manager", "accountant", "cashier"].includes(role));
  const canApprove = user.roles.some((role) => ["admin", "manager", "accountant"].includes(role));
  const [error, setError] = useState("");
  const [form, setForm] = useState({ category: "Other", amount: "", description: "", paymentMethod: "cash" });
  const expenses = useQuery({ queryKey: ["expenses"], queryFn: async () => (await api.get<{ expenses: Array<{
    id: number; category: string; amount: string; description: string; paymentMethod: string;
    status: string; createdAt: string; createdBy: string;
  }> }>("/expenses")).data.expenses });
  const create = useMutation({ mutationFn: () => api.post("/expenses", form), onSuccess: () => { setForm({ ...form, amount: "", description: "" }); setError(""); void query.invalidateQueries({ queryKey: ["expenses"] }); }, onError: (reason) => setError(getErrorMessage(reason)) });
  const decide = useMutation({ mutationFn: ({ id, decision }: { id: number; decision: "approved" | "rejected" }) => api.post(`/expenses/${id}/decision`, { decision }), onSuccess: () => void query.invalidateQueries({ queryKey: ["expenses"] }), onError: (reason) => setError(getErrorMessage(reason)) });
  return <section className="page-content operations-page"><PageHeader eyebrow="OPERATING COSTS" title="Expenses" detail="Record branch costs and keep approvals in one auditable place." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
    {expenses.isError && <ErrorBanner message={getErrorMessage(expenses.error)} onRetry={() => void expenses.refetch()} />}
    {canCreate && <section className="panel operation-form-panel"><div className="panel-heading"><div><div className="eyebrow">NEW EXPENSE</div><h2>Record a business expense</h2></div><span className="pending-pill">Approval required</span></div>
      <form className="operation-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <label>Category<input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></label>
        <label>Amount (KES)<input required inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
        <label>Payment method<select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}><option value="cash">Cash</option><option value="mpesa">M-PESA</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option></select></label>
        <label>Description<input required minLength={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <button className="button button-dark" disabled={create.isPending}>{create.isPending ? "Submitting…" : "Submit for approval"}</button>
      </form>
    </section>}
    <section className="panel operation-table-panel"><div className="panel-heading"><div><div className="eyebrow">BRANCH LEDGER</div><h2>Recent expenses</h2></div></div>
      <div className="product-table-wrap"><table className="product-table"><thead><tr><th>CATEGORY</th><th>DESCRIPTION</th><th>METHOD</th><th>AMOUNT</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{expenses.data?.map((expense) => <tr key={expense.id}><td className="stock-cell">{expense.category}</td><td>{expense.description}</td><td>{expense.paymentMethod.replace("_", " ").toUpperCase()}</td><td className="price-cell">{money(expense.amount)}</td><td><span className={`product-status ${expense.status !== "approved" ? "status-low" : ""}`}><i /> {expense.status.toUpperCase()}</span></td><td className="row-actions">{expense.status === "pending" && canApprove && <><button className="small-action" onClick={() => decide.mutate({ id: expense.id, decision: "approved" })} disabled={decide.isPending}>Approve</button><button className="small-action reject-action" onClick={() => decide.mutate({ id: expense.id, decision: "rejected" })} disabled={decide.isPending}>Reject</button></>}</td></tr>)}</tbody></table>{!expenses.isPending && !expenses.data?.length && <EmptyState title="No expenses recorded" detail="New expense submissions will show here." />}</div>
    </section>
  </section>;
}

function ReceiptDialog({
  receipt,
  width,
  onWidthChange,
  onClose,
  onNewSale,
  allowPrinting = true,
}: {
  receipt: SaleReceipt;
  width: "58mm" | "80mm";
  onWidthChange: (width: "58mm" | "80mm") => void;
  onClose: () => void;
  onNewSale?: () => void;
  allowPrinting?: boolean;
}) {
  const printReceipt = () => window.print();
  const amountPaid = receipt.payments
    .filter((payment) => payment.status === "completed")
    .reduce((total, payment) => total + Number(payment.amount), 0);
  const changeDue = Number(receipt.sale.changeDue);
  return <div className="receipt-backdrop">
    <section className={`receipt-dialog receipt-${width === "58mm" ? "58" : "80"}`} role="dialog" aria-modal="true" aria-label="Sale receipt">
      <div className="receipt-toolbar no-print">
        <label>Paper size<select value={width} onChange={(event) => onWidthChange(event.target.value as "58mm" | "80mm")}><option value="58mm">58 mm</option><option value="80mm">80 mm</option></select></label>
        {allowPrinting && <>
          <button onClick={printReceipt}><Printer size={16} /> Print</button>
          <button onClick={printReceipt}><Download size={16} /> Print / Save PDF</button>
        </>}
        {onNewSale && <button className="receipt-next-sale" onClick={onNewSale}><Plus size={16} /> Start New Sale</button>}
        <button className="receipt-close" onClick={onClose}>Close</button>
      </div>
      {onNewSale && <div className="receipt-ready-note no-print" role="status">Receipt ready. Print it now or start your next sale.</div>}
      <article className={`receipt-paper paper-${width === "58mm" ? "58" : "80"}`}>
        <header className="receipt-brand">
          {receipt.business.logoUrl
            ? <img className="receipt-logo" src={receipt.business.logoUrl} alt={`${receipt.business.name} logo`} />
            : <span className="receipt-business-mark">{receipt.business.name.slice(0, 1).toUpperCase()}</span>}
          <strong>{receipt.business.name}</strong>
          <small>{receipt.sale.branch}</small>
          <small>{receipt.business.phone} · {receipt.business.address}</small>
        </header>
        <div className="receipt-meta">
          <div><span>RECEIPT</span><strong>{receipt.sale.receiptNumber}</strong></div>
          <div><span>TRANSACTION</span><strong>#{receipt.sale.id}</strong></div>
          <div><span>DATE</span><strong>{new Date(receipt.sale.createdAt).toLocaleString("en-KE")}</strong></div>
          <div><span>CASHIER</span><strong>{receipt.sale.cashier}</strong></div>
          {receipt.sale.customer && <div><span>CUSTOMER</span><strong>{receipt.sale.customer}</strong></div>}
        </div>
        <table className="receipt-items"><thead><tr><th>ITEM</th><th>QTY</th><th>TOTAL</th></tr></thead><tbody>
          {receipt.items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.sku} · {money(item.unitPrice)} each</small></td><td>{Number(item.quantity).toLocaleString("en-KE")}</td><td>{money(item.lineTotal)}</td></tr>)}
        </tbody></table>
        <div className="receipt-totals">
          <div><span>Subtotal</span><strong>{money(receipt.sale.subtotal)}</strong></div>
          <div><span>Discount</span><strong>-{money(receipt.sale.discount)}</strong></div>
          <div><span>VAT / Tax</span><strong>{money(receipt.sale.tax)}</strong></div>
          <div className="receipt-total"><span>TOTAL</span><strong>{money(receipt.sale.total)}</strong></div>
        </div>
        <div className="receipt-payment">
          <strong>PAYMENT</strong>
          {receipt.payments.map((payment, index) => <div key={`${payment.method}-${index}`}><span>{payment.method.replaceAll("_", " ").toUpperCase()}</span><strong>{money(payment.amount)}</strong>{payment.reference && <small>Ref: {payment.reference}</small>}</div>)}
          <div><span>Amount paid</span><strong>{money(amountPaid)}</strong></div>
          {receipt.payments.some((payment) => payment.method === "cash") && <div><span>Amount received</span><strong>{money(receipt.sale.cashReceived ?? receipt.sale.total)}</strong></div>}
          <div><span>{changeDue > 0 ? "Change" : "Balance"}</span><strong>{money(changeDue)}</strong></div>
        </div>
        <footer className="receipt-thanks">Thank you for shopping with us!</footer>
      </article>
    </section>
  </div>;
}

function SalesPage({ user }: { user: User }) {
  const query = useQueryClient();
  const isAdmin = user.roles.includes("admin");
  const canViewAll = isAdmin || user.modules?.includes("transaction_all") === true;
  const canViewDetails = user.modules?.includes("transaction_details") === true;
  const canReprint = user.modules?.includes("transaction_reprint") === true;
  const canExport = user.modules?.includes("transaction_export") === true;
  const canCancel = user.modules?.includes("transaction_cancel") === true;
  const canRefund = user.modules?.includes("transaction_refund") === true;
  const canVerifyBankTransfer = isAdmin;
  const [detailSelected, setDetailSelected] = useState<number | null>(null);
  const [refundSelected, setRefundSelected] = useState<number | null>(null);
  const [receiptSelected, setReceiptSelected] = useState<number | null>(null);
  const [receiptWidth, setReceiptWidth] = useState<"58mm" | "80mm">("80mm");
  const [searchText, setSearchText] = useState("");
  const [cashierFilter, setCashierFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [branchId, setBranchId] = useState("");
  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const filters = {
    q: searchText, cashier: cashierFilter, from: fromDate, to: toDate,
    paymentMethod, status: statusFilter, branchId,
  };
  const sales = useQuery({ queryKey: ["sales", filters], queryFn: async () => (await api.get<{ sales: Array<{
    id: number; receiptNumber: string; branch: string; branchId: number; subtotal: string; discount: string; tax: string;
    total: string; amountPaid: string; cashReceived: string | null; changeDue: string; status: string; createdAt: string;
    cashierId: number; cashier: string; customer: string | null; itemCount: number; paymentMethod: string | null;
  }> }>("/sales", { params: filters })).data.sales });
  const branches = useQuery({
    queryKey: ["transaction-branches"],
    enabled: isAdmin,
    queryFn: async () => (await api.get<{ branches: Array<{ id: number; name: string; code: string }> }>("/staff/branches")).data.branches,
  });
  const refunds = useQuery({ queryKey: ["refunds"], enabled: canRefund, queryFn: async () => (await api.get<{ refunds: Array<{
    id: number; refundNumber: string; receiptNumber: string; reason: string; total: string;
    createdAt: string; createdBy: string;
  }> }>("/refunds")).data.refunds });
  const detail = useQuery({
    queryKey: ["sale-detail", detailSelected],
    enabled: detailSelected !== null,
    queryFn: async () => (await api.get<SaleReceipt>(`/sales/${detailSelected}`)).data,
  });
  const refundDetail = useQuery({
    queryKey: ["sale-refund-detail", refundSelected],
    enabled: refundSelected !== null,
    queryFn: async () => (await api.get<SaleReceipt>(`/sales/${refundSelected}`)).data,
  });
  const receiptQuery = useQuery({
    queryKey: ["sale-receipt", receiptSelected],
    enabled: receiptSelected !== null,
    queryFn: async () => (await api.get<SaleReceipt>(`/sales/${receiptSelected}/receipt`)).data,
  });
  const bankVerifications = useQuery({
    queryKey: ["bank-transfer-verifications"],
    enabled: canVerifyBankTransfer,
    queryFn: async () => (await api.get<{ verifications: Array<{
      id: number; cashierId: number; cashier: string; reference: string; amount: string; createdAt: string;
    }> }>("/bank-transfer-verifications")).data.verifications,
  });
  const reviewBankTransfer = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "approved" | "rejected" }) =>
      api.post(`/bank-transfer-verifications/${id}/decision`, { decision }),
    onSuccess: () => void query.invalidateQueries({ queryKey: ["bank-transfer-verifications"] }),
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const refund = useMutation({
    mutationFn: () => api.post(`/sales/${refundSelected}/refunds`, {
      reason,
      items: Object.entries(quantities).filter(([, quantity]) => Number(quantity) > 0)
        .map(([saleItemId, quantity]) => ({ saleItemId: Number(saleItemId), quantity })),
    }),
    onSuccess: () => {
      setError("");
      setRefundSelected(null);
      setReason("");
      setQuantities({});
      void query.invalidateQueries({ queryKey: ["sales"] });
      void query.invalidateQueries({ queryKey: ["inventory"] });
      void query.invalidateQueries({ queryKey: ["inventory-summary"] });
      void query.invalidateQueries({ queryKey: ["products"] });
      void query.invalidateQueries({ queryKey: ["refunds"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const cancel = useMutation({
    mutationFn: ({ id, reason: cancelReason }: { id: number; reason: string }) =>
      api.post(`/sales/${id}/cancel`, { reason: cancelReason }),
    onSuccess: () => {
      setError("");
      void query.invalidateQueries({ queryKey: ["sales"] });
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const exportTransactions = useMutation({
    mutationFn: async () => api.get<Blob>("/sales/export", { params: filters, responseType: "blob" }),
    onSuccess: ({ data }) => {
      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = "transaction-history.csv";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
    onError: (reason) => setError(getErrorMessage(reason)),
  });
  const cancelTransaction = (id: number) => {
    const cancelReason = window.prompt("Enter the reason for cancelling this pending transaction:");
    if (cancelReason === null) return;
    if (cancelReason.trim().length < 3) {
      setError("Enter a cancellation reason of at least 3 characters.");
      return;
    }
    setError("");
    cancel.mutate({ id, reason: cancelReason.trim() });
  };
  return <section className="page-content operations-page"><PageHeader eyebrow="TRANSACTION HISTORY" title="Transaction History" detail="Search receipts, inspect items and payments, and review authorized returns." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
    {sales.isError && <ErrorBanner message={getErrorMessage(sales.error)} onRetry={() => void sales.refetch()} />}
    {refunds.isError && canRefund && <ErrorBanner message={getErrorMessage(refunds.error)} onRetry={() => void refunds.refetch()} />}
    {detailSelected !== null && <section className="panel operation-form-panel">
      <div className="panel-heading"><div><div className="eyebrow">TRANSACTION DETAILS</div><h2>Receipt {detail.data?.sale.receiptNumber ?? "…"}</h2></div><button className="small-action" onClick={() => setDetailSelected(null)}>Close</button></div>
      {detail.isError && <ErrorBanner message={getErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />}
      {detail.isPending ? <LoadingRows /> : detail.data && <>
        <div className="transaction-detail-summary">
          <div><span>Transaction</span><strong>#{detail.data.sale.id}</strong></div>
          <div><span>Date</span><strong>{new Date(detail.data.sale.createdAt).toLocaleString("en-KE")}</strong></div>
          <div><span>Cashier</span><strong>{detail.data.sale.cashier}</strong></div>
          <div><span>Customer</span><strong>{detail.data.sale.customer ?? "Walk-in"}</strong></div>
          <div><span>Subtotal</span><strong>{money(detail.data.sale.subtotal)}</strong></div>
          <div><span>Discount</span><strong>{money(detail.data.sale.discount)}</strong></div>
          <div><span>Tax</span><strong>{money(detail.data.sale.tax)}</strong></div>
          <div><span>Total</span><strong>{money(detail.data.sale.total)}</strong></div>
          <div><span>Change</span><strong>{money(detail.data.sale.changeDue)}</strong></div>
          <div><span>Status</span><strong>{detail.data.sale.status}</strong></div>
        </div>
        <div className="product-table-wrap"><table className="product-table"><thead><tr><th>PRODUCT</th><th>SKU</th><th>QUANTITY</th><th>UNIT PRICE</th><th>LINE TOTAL</th></tr></thead><tbody>
          {detail.data.items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.sku}</td><td>{Number(item.quantity).toLocaleString("en-KE")}</td><td>{money(item.unitPrice)}</td><td className="price-cell">{money(item.lineTotal)}</td></tr>)}
        </tbody></table></div>
        <div className="transaction-payment-list"><strong>Payment methods</strong>{detail.data.payments.map((payment, index) => <span key={`${payment.method}-${index}`}>{payment.method.replaceAll("_", " ")} · {money(payment.amount)} · {payment.status}</span>)}
          <span>Cash received · {money(detail.data.sale.cashReceived ?? "0")}</span>
        </div>
      </>}
    </section>}
    {refundSelected !== null && <section className="panel operation-form-panel"><div className="panel-heading"><div><div className="eyebrow">RETURN ITEMS</div><h2>Receipt {refundDetail.data?.sale.receiptNumber ?? "…"}</h2></div><button className="small-action reject-action" onClick={() => { setRefundSelected(null); setQuantities({}); }}>Cancel</button></div>
      {refundDetail.isError && <ErrorBanner message={getErrorMessage(refundDetail.error)} onRetry={() => void refundDetail.refetch()} />}
      {refundDetail.isPending ? <LoadingRows /> : refundDetail.data && <form className="return-form" onSubmit={(event) => { event.preventDefault(); setError(""); refund.mutate(); }}>
        <p>Enter the quantity to return for each item. Refund is paid in cash and stock is restored after approval.</p>
        {refundDetail.data.items.map((item) => {
          const remaining = Number(item.quantity) - Number(item.refunded ?? 0);
          return <label className="return-item" key={item.id}><span><strong>{item.name}</strong><small>{remaining.toFixed(3)} remaining · line {money(item.lineTotal)}</small></span><input aria-label={`Quantity to return for ${item.name}`} type="number" step="0.001" min="0" max={remaining} value={quantities[item.id] ?? ""} onChange={(event) => setQuantities({ ...quantities, [item.id]: event.target.value })} /></label>;
        })}
        <label className="return-reason">Reason<input required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for refund" /></label>
        <button className="button button-dark" disabled={refund.isPending || !Object.values(quantities).some((value) => Number(value) > 0)}>{refund.isPending ? "Processing refund…" : "Confirm cash refund"}</button>
      </form>}
    </section>}
    {canVerifyBankTransfer && <section className="panel operation-table-panel"><div className="panel-heading"><div><div className="eyebrow">BANK SETTLEMENT REVIEW</div><h2>Pending transfer verification</h2></div></div>
      <p className="bank-review-notice">Check each reference against the bank statement before approving it. Approval authorizes a cashier to complete a sale for this exact amount.</p>
      {bankVerifications.isError && <ErrorBanner message={getErrorMessage(bankVerifications.error)} onRetry={() => void bankVerifications.refetch()} />}
      <div className="product-table-wrap"><table className="product-table"><thead><tr><th>REFERENCE</th><th>CASHIER</th><th>SUBMITTED</th><th>AMOUNT</th><th>REVIEW</th></tr></thead><tbody>{bankVerifications.data?.map((transfer) => <tr key={transfer.id}><td className="sku-cell">{transfer.reference}</td><td>{transfer.cashier}</td><td>{new Date(transfer.createdAt).toLocaleString("en-KE")}</td><td className="price-cell">{money(transfer.amount)}</td><td className="row-actions"><button className="small-action" disabled={reviewBankTransfer.isPending} onClick={() => {
        if (window.confirm(`Confirm that transfer ${transfer.reference} for ${money(transfer.amount)} is visible in the bank account?`)) {
          reviewBankTransfer.mutate({ id: transfer.id, decision: "approved" });
        }
      }}>Approve verified</button><button className="small-action reject-action" disabled={reviewBankTransfer.isPending} onClick={() => reviewBankTransfer.mutate({ id: transfer.id, decision: "rejected" })}>Reject</button></td></tr>)}</tbody></table>{!bankVerifications.isPending && !bankVerifications.data?.length && <EmptyState title="No transfers awaiting review" detail="Cashiers' bank transfer verification requests will appear here." />}</div>
    </section>}
    <section className="panel operation-table-panel"><div className="products-toolbar"><div><div className="eyebrow">REGISTER TRANSACTIONS</div><h2>Sales and receipts</h2></div>
      {canExport && <button className="button button-dark" disabled={exportTransactions.isPending} onClick={() => exportTransactions.mutate()}>{exportTransactions.isPending ? "Exporting…" : "Export CSV"}</button>}
    </div>
      <div className="sales-search-bar">
        <label>Receipt, transaction or customer<input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Receipt number, ID, customer" /></label>
        {canViewAll && <label>Cashier<input value={cashierFilter} onChange={(event) => setCashierFilter(event.target.value)} placeholder="Filter by cashier name" /></label>}
        {isAdmin && <label>Branch<select value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{branches.data?.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
        <label>From<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label>To<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
        <label>Payment method<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="">All methods</option><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option><option value="credit">Credit</option></select></label>
        <label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="cancelled">Cancelled</option><option value="refunded">Refunded</option></select></label>
      </div>
      <div className="product-table-wrap"><table className="product-table"><thead><tr>
        <th>RECEIPT / ID</th><th>DATE &amp; TIME</th>{canViewAll && <th>BRANCH</th>}<th>CASHIER</th><th>CUSTOMER</th><th>PRODUCTS</th>
        <th>SUBTOTAL</th><th>DISCOUNT</th><th>TAX</th><th>TOTAL</th><th>METHOD</th><th>AMOUNT PAID</th><th>CHANGE</th><th>STATUS</th><th>ACTIONS</th>
      </tr></thead><tbody>{sales.data?.map((sale) => <tr key={sale.id}>
        <td className="sku-cell">{sale.receiptNumber}<small>#{sale.id}</small></td>
        <td>{new Date(sale.createdAt).toLocaleString("en-KE")}</td>{canViewAll && <td>{sale.branch}</td>}
        <td>{sale.cashier}</td><td>{sale.customer ?? "Walk-in"}</td><td>{sale.itemCount}</td>
        <td>{money(sale.subtotal)}</td><td>{money(sale.discount)}</td><td>{money(sale.tax)}</td>
        <td className="price-cell">{money(sale.total)}</td><td>{sale.paymentMethod?.replaceAll(",", " / ") ?? "—"}</td>
        <td>{money(sale.amountPaid)}</td><td>{money(sale.changeDue)}</td><td><span className={`product-status ${sale.status !== "completed" ? "status-low" : ""}`}><i /> {sale.status.toUpperCase()}</span></td>
        <td className="row-actions">
          {canViewDetails && <button className="small-action" onClick={() => { setDetailSelected(sale.id); setError(""); }}>Details</button>}
          {canReprint && <button className="small-action" onClick={() => { setReceiptSelected(sale.id); setError(""); }}>Receipt</button>}
          {canRefund && canViewDetails && sale.status === "completed" && <button className="small-action" onClick={() => { setRefundSelected(sale.id); setError(""); }}>Return</button>}
          {canCancel && sale.status === "pending" && <button className="small-action reject-action" disabled={cancel.isPending} onClick={() => cancelTransaction(sale.id)}>Cancel transaction</button>}
        </td>
      </tr>)}</tbody></table>
        {sales.isPending && <LoadingRows />}
        {!sales.isPending && !sales.data?.length && <EmptyState title="No transactions found" detail="Adjust the search or filters to find another transaction." />}
      </div>
    </section>
    {canRefund && <section className="panel operation-table-panel"><div className="panel-heading"><div><div className="eyebrow">CASH REFUNDS</div><h2>Recent returns</h2></div></div>
      <div className="product-table-wrap"><table className="product-table"><thead><tr><th>REFUND</th><th>RECEIPT</th><th>REASON</th><th>PROCESSED BY</th><th>DATE</th><th>AMOUNT</th></tr></thead><tbody>{refunds.data?.map((refund) => <tr key={refund.id}><td className="sku-cell">{refund.refundNumber}</td><td>{refund.receiptNumber}</td><td>{refund.reason}</td><td>{refund.createdBy}</td><td>{new Date(refund.createdAt).toLocaleString("en-KE")}</td><td className="price-cell">{money(refund.total)}</td></tr>)}</tbody></table>{!refunds.isPending && !refunds.data?.length && <EmptyState title="No returns recorded" detail="Processed cash refunds will appear here." />}</div>
    </section>}
    {receiptSelected !== null && receiptQuery.data && <ReceiptDialog receipt={receiptQuery.data} width={receiptWidth} onWidthChange={setReceiptWidth} onClose={() => setReceiptSelected(null)} allowPrinting={canReprint} />}
    {receiptSelected !== null && receiptQuery.isError && <ErrorBanner message={getErrorMessage(receiptQuery.error)} onRetry={() => void receiptQuery.refetch()} />}
  </section>;
}

function ReportsPage({ user }: { user: User }) {
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  const [from, setFrom] = useState(dateInputValue(thirtyDaysAgo));
  const [to, setTo] = useState(dateInputValue(today));
  const canView = user.roles.some((role) => ["admin", "manager", "accountant"].includes(role));
  const validRange = Boolean(from && to && from <= to);
  const report = useQuery({
    queryKey: ["reports", from, to],
    enabled: canView && validRange,
    queryFn: async () => (await api.get<BranchReport>("/reports/summary", { params: { from, to } })).data,
  });
  const data = report.data;
  const downloadCsv = () => {
    if (!data) return;
    const rows: Array<Array<string | number>> = [
      ["Section", "Metric", "Value"],
      ["Summary", "Sales revenue (excl. tax)", data.summary.revenue],
      ["Summary", "Tax collected", data.summary.tax],
      ["Summary", "Transactions", data.summary.transactions],
      ["Summary", "Average order", data.summary.averageOrder],
      ["Summary", "Refunds", data.summary.refunds],
      ["Summary", "Net revenue", data.summary.netRevenue],
      ["Summary", "Gross profit", data.summary.grossProfit ?? "Unavailable: cost data incomplete"],
      ["Summary", "Approved expenses", data.summary.expenses],
      ["Summary", "Net profit", data.summary.netProfit ?? "Unavailable: cost data incomplete"],
      ...data.salesTrend.map((row) => ["Daily sales", row.date, row.revenue]),
      ...data.topProducts.map((row) => ["Top products", row.name, `${row.quantity} units; ${row.revenue} revenue`]),
      ...data.salesByCashier.map((row) => ["Cashiers", row.name, `${row.transactions} transactions; ${row.revenue} revenue`]),
      ...data.payments.map((row) => ["Payments", row.method, row.amount]),
      ...data.expensesByCategory.map((row) => ["Expenses", row.category, row.amount]),
    ];
    const csv = rows.map((row) => row.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `smart-pos-report-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  if (!canView) return <Navigate to="/" replace />;
  return (
    <section className="page-content report-page">
      <div className="report-heading">
        <PageHeader eyebrow="BRANCH PERFORMANCE" title="Reports" detail="Sales, stock, expenses, and profitability from live branch records." />
        <div className="report-controls">
          <label><span>FROM</span><CalendarDays size={15} /><input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
          <label><span>TO</span><CalendarDays size={15} /><input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
          <Link className="button button-dark" to="/reports/daily">Daily evaluation</Link>
          <button className="button button-dark" onClick={downloadCsv} disabled={!data}><Download size={15} /> Export CSV</button>
        </div>
      </div>
      {!validRange && <div role="alert" className="error-banner">Choose a valid date range. The start date must not be after the end date.</div>}
      {report.isError && <ErrorBanner message={getErrorMessage(report.error)} onRetry={() => void report.refetch()} />}
      {report.isPending && validRange && <div className="report-loading"><LoadingRows /></div>}
      {data && <>
        <div className="metric-grid report-metrics">
          <MetricCard label="SALES REVENUE · EXCL. TAX" value={money(data.summary.revenue)} caption={`${data.summary.transactions} completed transactions`} icon={<CircleDollarSign size={17} />} tone="green" loading={false} />
          <MetricCard label="NET REVENUE" value={money(data.summary.netRevenue)} caption={`${money(data.summary.refunds)} refunded in period`} icon={<RotateCcw size={17} />} loading={false} />
          <MetricCard label="GROSS PROFIT" value={data.summary.grossProfit === null ? "Unavailable" : money(data.summary.grossProfit)} caption={`${data.summary.costCoverage.toFixed(1)}% of sold units have cost data`} icon={<TrendingUp size={17} />} tone={data.summary.grossProfit === null ? "amber" : "green"} loading={false} />
          <MetricCard label="APPROVED EXPENSES" value={money(data.summary.expenses)} caption={`${money(data.summary.pendingExpenses)} pending approval`} icon={<ReceiptText size={17} />} loading={false} />
        </div>
        {data.summary.grossProfit === null && <div className="report-notice">Profit is withheld until cost data is available for every sold and refunded unit in this period. Historical lines without a recorded cost remain unknown.</div>}
        <Suspense fallback={<div className="panel report-panel report-loading">Loading report charts…</div>}>
          <ReportsCharts report={data} from={from} to={to} />
        </Suspense>
        <div className="report-chart-grid">
          <section className="panel report-panel">
            <div className="panel-heading"><div><div className="eyebrow">CASHIER PERFORMANCE</div><h2>Sales by cashier</h2></div></div>
            <div className="product-table-wrap"><table className="product-table"><thead><tr><th>CASHIER</th><th>TRANSACTIONS</th><th>REVENUE</th></tr></thead><tbody>
              {data.salesByCashier.map((cashier) => <tr key={cashier.name}><td>{cashier.name}</td><td>{cashier.transactions}</td><td className="price-cell">{money(cashier.revenue)}</td></tr>)}
            </tbody></table>{!data.salesByCashier.length && <EmptyState title="No sales by cashier" detail="Cashier breakdown appears when sales are recorded." />}</div>
          </section>
          <section className="panel report-panel">
            <div className="panel-heading"><div><div className="eyebrow">BEST SELLERS</div><h2>Top products</h2></div></div>
            <div className="product-table-wrap"><table className="product-table"><thead><tr><th>PRODUCT</th><th>UNITS SOLD</th><th>REVENUE</th></tr></thead><tbody>
              {data.topProducts.map((product) => <tr key={product.sku}><td><div className="report-product"><strong>{product.name}</strong><small>{product.sku}</small></div></td><td>{Number(product.quantity).toLocaleString("en-KE")}</td><td className="price-cell">{money(product.revenue)}</td></tr>)}
            </tbody></table>{!data.topProducts.length && <EmptyState title="No product sales" detail="Product rankings appear when sales are recorded." />}</div>
          </section>
        </div>
        <div className="report-chart-grid">
          <section className="panel report-panel">
            <div className="panel-heading"><div><div className="eyebrow">INVENTORY HEALTH</div><h2>Stock value & low stock</h2></div></div>
            <div className="report-stock-summary"><strong>{money(data.summary.inventoryValue)}</strong><span>Estimated value · {Number(data.summary.inventoryUnits).toLocaleString("en-KE")} units</span></div>
            <div className="product-table-wrap"><table className="product-table"><thead><tr><th>PRODUCT</th><th>AVAILABLE</th><th>REORDER AT</th></tr></thead><tbody>
              {data.lowStock.map((product) => <tr key={product.id}><td><div className="report-product"><strong>{product.name}</strong><small>{product.sku}</small></div></td><td>{Number(product.available).toLocaleString("en-KE")}</td><td>{Number(product.reorderLevel).toLocaleString("en-KE")}</td></tr>)}
            </tbody></table>{!data.lowStock.length && <EmptyState title="Stock looks healthy" detail="No active products are at or below reorder level." />}</div>
          </section>
          <section className="panel report-panel">
            <div className="panel-heading"><div><div className="eyebrow">COSTS & CASH FLOW</div><h2>Period totals</h2></div></div>
            <div className="report-stat-list">
              <div><span>Tax collected</span><strong>{money(data.summary.tax)}</strong></div>
              <div><span>Purchase receipts</span><strong>{money(data.summary.purchaseSpend)}</strong></div>
              <div><span>Net profit</span><strong>{data.summary.netProfit === null ? "Unavailable" : money(data.summary.netProfit)}</strong></div>
              <div><span>Inventory units</span><strong>{Number(data.summary.inventoryUnits).toLocaleString("en-KE")}</strong></div>
              <div><span>Average order</span><strong>{money(data.summary.averageOrder)}</strong></div>
            </div>
            <div className="report-subsection"><div className="eyebrow">EXPENSES BY CATEGORY</div>
              {data.expensesByCategory.length ? data.expensesByCategory.map((expense) => <div className="report-stat-row" key={expense.category}><span>{expense.category}</span><strong>{money(expense.amount)}</strong></div>) : <p className="report-empty-note">No approved expenses in this period.</p>}
            </div>
          </section>
        </div>
      </>}
    </section>
  );
}

function DailyEvaluationPage({ user }: { user: User }) {
  const [date, setDate] = useState(() => dateInputValue(new Date()));
  const [branchId, setBranchId] = useState("");
  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: async () => (await api.get("/branches")).data as Array<{ id: number; name: string; code: string }>,
  });
  const evaluation = useQuery({
    queryKey: ["daily-evaluation", date, branchId],
    enabled: Boolean(date),
    queryFn: async () => (await api.get("/reports/daily-evaluation", {
      params: { date, ...(branchId ? { branchId: Number(branchId) } : {}) },
    })).data as {
      date: string;
      summary: {
        grossSales: string; completedTransactions: number; averageTransaction: string;
        refunds: string; salesAfterRefunds: string; approvedExpenses: string; salesAfterRefundsAndExpenses: string;
      };
      payments: Array<{ method: string; amount: string; transactions: number }>;
      transactions: Array<{
        id: string; kind: "sale" | "refund" | "expense"; reference: string; amount: string;
        status: string; actor: string; customer: string | null; description: string;
        paymentMethod: string | null; branch: string; createdAt: string;
      }>;
    },
  });
  const data = evaluation.data;
  return <section className="page-content report-page daily-evaluation-page">
    <div className="report-heading">
      <PageHeader eyebrow="DAILY BUSINESS REVIEW" title="Daily evaluation" detail="Review every sale, refund and expense recorded for the selected day." />
      <div className="daily-evaluation-controls">
        <label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>Branch<select value={branchId} onChange={(event) => setBranchId(event.target.value)} disabled={branches.isPending || branches.isError}>
          <option value="">All accessible branches</option>
          {(branches.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select></label>
        <Link className="button button-dark" to="/reports">Reports</Link>
      </div>
    </div>
    {branches.isError && <ErrorBanner message={getErrorMessage(branches.error)} onRetry={() => void branches.refetch()} />}
    {evaluation.isError && <ErrorBanner message={getErrorMessage(evaluation.error)} onRetry={() => void evaluation.refetch()} />}
    {evaluation.isPending ? <div className="report-loading"><LoadingRows /></div> : data && <>
      <div className="metric-grid report-metrics">
        <MetricCard label="GROSS SALES" value={money(data.summary.grossSales)} caption={`${data.summary.completedTransactions} completed sales`} icon={<CircleDollarSign size={17} />} tone="green" loading={false} />
        <MetricCard label="REFUNDS" value={money(data.summary.refunds)} caption="Completed cash refunds" icon={<RotateCcw size={17} />} loading={false} />
        <MetricCard label="SALES AFTER REFUNDS" value={money(data.summary.salesAfterRefunds)} caption="Gross sales less completed refunds" icon={<TrendingUp size={17} />} tone="green" loading={false} />
        <MetricCard label="APPROVED EXPENSES" value={money(data.summary.approvedExpenses)} caption="Expenses approved for this day" icon={<ReceiptText size={17} />} loading={false} />
        <MetricCard label="AFTER REFUNDS & EXPENSES" value={money(data.summary.salesAfterRefundsAndExpenses)} caption="Simple review figure, not profit" icon={<CircleDollarSign size={17} />} loading={false} />
        <MetricCard label="AVERAGE SALE" value={money(data.summary.averageTransaction)} caption="Average completed transaction" icon={<ShoppingBasket size={17} />} loading={false} />
      </div>
      <div className="report-notice">The after-refunds-and-expenses figure is a simple daily review only; it is not net profit and does not include product costs or other accounting adjustments.</div>
      <div className="report-chart-grid">
        <section className="panel report-panel">
          <div className="panel-heading"><div><div className="eyebrow">PAYMENT BREAKDOWN</div><h2>Completed payments</h2></div></div>
          {data.payments.length ? <div className="report-stat-list">{data.payments.map((payment) => <div key={payment.method}>
            <span>{payment.method.replaceAll("_", " ")} · {payment.transactions} sale(s)</span><strong>{money(payment.amount)}</strong>
          </div>)}</div> : <EmptyState title="No completed payments" detail="Completed payment totals will appear here." />}
        </section>
        <section className="panel report-panel">
          <div className="panel-heading"><div><div className="eyebrow">DAY CHECK</div><h2>Transaction count</h2></div></div>
          <div className="report-stat-list">
            <div><span>All ledger entries</span><strong>{data.transactions.length}</strong></div>
            <div><span>Sales</span><strong>{data.transactions.filter((item) => item.kind === "sale").length}</strong></div>
            <div><span>Refunds</span><strong>{data.transactions.filter((item) => item.kind === "refund").length}</strong></div>
            <div><span>Expenses</span><strong>{data.transactions.filter((item) => item.kind === "expense").length}</strong></div>
          </div>
        </section>
      </div>
      <section className="panel operation-table-panel daily-ledger-panel">
        <div className="panel-heading"><div><div className="eyebrow">COMPLETE DAILY LEDGER</div><h2>{new Date(`${data.date}T00:00:00`).toLocaleDateString("en-KE", { dateStyle: "full" })}</h2></div><span className="count-badge">{data.transactions.length}</span></div>
        <div className="product-table-wrap"><table className="product-table"><thead><tr>
          <th>TYPE</th><th>REFERENCE</th><th>TIME</th><th>BRANCH</th><th>USER</th><th>CUSTOMER / DETAILS</th><th>PAYMENT</th><th>AMOUNT</th><th>STATUS</th>
        </tr></thead><tbody>{data.transactions.map((transaction) => <tr key={transaction.id}>
          <td><span className={`enterprise-status ${transaction.kind === "sale" ? "success" : transaction.kind === "refund" ? "warning" : "neutral"}`}>{transaction.kind}</span></td>
          <td className="sku-cell">{transaction.reference}</td>
          <td>{new Date(transaction.createdAt).toLocaleTimeString("en-KE")}</td>
          <td>{transaction.branch}</td><td>{transaction.actor}</td>
          <td>{transaction.kind === "sale" ? `${transaction.customer ?? "Walk-in"} · ${transaction.description}` : transaction.description}</td>
          <td>{transaction.paymentMethod?.replaceAll("_", " ") || "—"}</td>
          <td className="price-cell">{money(transaction.amount)}</td>
          <td><span className={`enterprise-status ${transaction.status === "completed" || transaction.status === "approved" ? "success" : transaction.status === "rejected" || transaction.status === "cancelled" ? "danger" : "warning"}`}>{transaction.status.replaceAll("_", " ")}</span></td>
        </tr>)}</tbody></table>
          {!data.transactions.length && <EmptyState title="No activity recorded" detail="No sales, refunds or expenses were recorded for this date and branch selection." />}
        </div>
      </section>
    </>}
    {user.roles.includes("admin") && <p className="daily-evaluation-footnote">Administrator view includes all branches. Other authorized users see only their assigned branches.</p>}
  </section>;
}

function PageHeader({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> {eyebrow}</div><h1>{title}<span className="heading-period">.</span></h1><p>{detail}</p></div></div>;
}

function EnterpriseTable({ columns, rows }: { columns: string[]; rows: Array<Array<ReactNode>> }) {
  return <div className="enterprise-table-wrap"><table className="enterprise-table">
    <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
}

function EnterprisePageShell({ title, eyebrow, actions, children }: { title: string; eyebrow: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="page-content enterprise-page">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> {eyebrow}</div><h1>{title}</h1></div>{actions}</div>
    {children}
  </section>;
}

function BranchesPage() {
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: async () => (await api.get("/branches")).data as Array<{ id: number; name: string; code: string; address: string | null; phone: string | null; isActive: boolean }>,
  });
  const create = useMutation({
    mutationFn: async (values: { name: string; code: string; address: string; phone: string; email: string }) =>
      (await api.post("/branches", { ...values, isActive: true, allowNegativeStock: false })).data,
    onSuccess: () => {
      setSuccess("Branch created successfully.");
      setFormError("");
      void branches.refetch();
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });
  const branchRows = branches.data ?? [];
  return <EnterprisePageShell title="Branch Management" eyebrow="ENTERPRISE NETWORK" actions={<button className="button button-dark" onClick={() => document.querySelector<HTMLInputElement>("#branch-name")?.focus()}><Plus size={15} /> Add branch</button>}>
    {formError && <div role="alert" className="error-banner">{formError}</div>}
    {success && <div role="status" className="success-banner">{success}</div>}
    <div className="enterprise-grid">
      <section className="panel enterprise-form-panel">
        <div className="panel-heading"><div><div className="eyebrow">NEW LOCATION</div><h2>Register branch</h2></div></div>
        <form className="enterprise-form" onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          setFormError("");
          setSuccess("");
          create.mutate({
            name: String(values.get("name") ?? ""),
            code: String(values.get("code") ?? ""),
            address: String(values.get("address") ?? ""),
            phone: String(values.get("phone") ?? ""),
            email: String(values.get("email") ?? ""),
          });
        }}>
          <label>Branch name<input id="branch-name" name="name" required placeholder="e.g. Westlands Branch" /></label>
          <label>Branch code<input name="code" required placeholder="WEST" /></label>
          <label>Address<input name="address" placeholder="Physical address" /></label>
          <label>Phone<input name="phone" placeholder="+254..." /></label>
          <label>Email<input name="email" type="email" placeholder="branch@example.com" /></label>
          <button className="button button-dark" disabled={create.isPending}>{create.isPending ? "Saving…" : "Create branch"}</button>
        </form>
      </section>
      <section className="panel enterprise-table-panel">
        <div className="panel-heading"><div><div className="eyebrow">LOCATIONS</div><h2>Active branches</h2></div><span className="count-badge">{branchRows.length}</span></div>
        {branches.isPending ? <LoadingRows /> : branches.isError ? <ErrorBanner message={getErrorMessage(branches.error)} onRetry={() => void branches.refetch()} /> :
          branchRows.length ? <EnterpriseTable
            columns={["Branch", "Code", "Address", "Phone", "Status"]}
            rows={branchRows.map((branch) => [
              <strong key="name">{branch.name}</strong>,
              branch.code,
              branch.address || "—",
              branch.phone || "—",
              <span key="status" className={`enterprise-status ${branch.isActive ? "success" : "warning"}`}>{branch.isActive ? "Active" : "Inactive"}</span>,
            ])}
          /> : <EmptyState title="No branches" detail="Create the first branch location." />}
      </section>
    </div>
  </EnterprisePageShell>;
}

function OfflineSyncPage() {
  const sync = useQuery({
    queryKey: ["offline-sync"],
    queryFn: async () => (await api.get("/sync-monitor/offline-sales")).data as Array<{ offlineId: string; branch: string; cashier: string; status: string; receiptNumber: string | null; attempts: number; error: string | null; createdAt: string }>,
  });
  const rows = sync.data ?? [];
  return <EnterprisePageShell title="Offline Synchronization" eyebrow="POS NETWORK MONITOR" actions={<button className="button button-light" onClick={() => void sync.refetch()}><RefreshCw size={15} /> Refresh</button>}>
    <section className="panel enterprise-table-panel">
      <div className="panel-heading"><div><div className="eyebrow">SYNC QUEUE</div><h2>Transaction monitor</h2></div><span className="count-badge">{rows.length}</span></div>
      {sync.isPending ? <LoadingRows /> : sync.isError ? <ErrorBanner message={getErrorMessage(sync.error)} onRetry={() => void sync.refetch()} /> :
        rows.length ? <EnterpriseTable
          columns={["Offline ID", "Branch", "Cashier", "Status", "Receipt", "Attempts", "Created"]}
          rows={rows.map((row) => [row.offlineId, row.branch, row.cashier,
            <span key="status" className={`enterprise-status ${row.status === "synced" ? "success" : row.status === "failed" ? "danger" : "warning"}`}>{row.status.toUpperCase()}</span>,
            row.receiptNumber || "—", row.attempts, new Date(row.createdAt).toLocaleString("en-KE")])}
        /> : <EmptyState title="No offline transactions" detail="Pending offline sales will appear here." />}
    </section>
  </EnterprisePageShell>;
}

function BackupsPage() {
  const backups = useQuery({
    queryKey: ["backups"],
    queryFn: async () => (await api.get("/backups")).data as Array<{ id: number; filename: string; status: string; sizeBytes: number | null; checksum: string; createdAt: string }>,
  });
  const create = useMutation({
    mutationFn: async () => (await api.post("/backups/create")).data,
    onSuccess: () => void backups.refetch(),
  });
  const backupRows = backups.data ?? [];
  return <EnterprisePageShell title="Database Backups" eyebrow="DATA PROTECTION" actions={<button className="button button-dark" onClick={() => create.mutate()} disabled={create.isPending}><ShieldCheck size={15} /> {create.isPending ? "Creating…" : "Create backup"}</button>}>
    {create.isError && <div role="alert" className="error-banner">{getErrorMessage(create.error)}</div>}
    <section className="panel enterprise-summary-panel">
      <div className="panel-heading"><div><div className="eyebrow">POLICY</div><h2>Backup configuration</h2></div></div>
      <p>Encrypted backups are written to <strong>BACKUP_STORAGE_DIR</strong> outside the live database. Scheduled jobs and restoration require administrator control.</p>
    </section>
    <section className="panel enterprise-table-panel">
      <div className="panel-heading"><div><div className="eyebrow">HISTORY</div><h2>Available backups</h2></div><span className="count-badge">{backupRows.length}</span></div>
      {backups.isPending ? <LoadingRows /> : backups.isError ? <ErrorBanner message={getErrorMessage(backups.error)} onRetry={() => void backups.refetch()} /> : backupRows.length ? <EnterpriseTable
        columns={["File", "Status", "Size", "Checksum", "Created"]}
        rows={backupRows.map((row) => [row.filename, <span key="status" className={`enterprise-status ${row.status === "verified" ? "success" : "danger"}`}>{row.status}</span>, row.sizeBytes ? `${Math.ceil(row.sizeBytes / 1024)} KB` : "—", row.checksum.slice(0, 16), new Date(row.createdAt).toLocaleString("en-KE")])}
      /> : <EmptyState title="No backups" detail="Create the first verified database backup." />}
    </section>
  </EnterprisePageShell>;
}

function PriceHistoryPage() {
  const [search, setSearch] = useState("");
  const history = useQuery({
    queryKey: ["price-history", search],
    queryFn: async () => (await api.get("/price-history", { params: { q: search || undefined } })).data as Array<{ productName: string; sku: string; branch: string | null; changedBy: string | null; previousBuyingPrice: string | null; newBuyingPrice: string | null; previousSellingPrice: string | null; newSellingPrice: string | null; reason: string | null; createdAt: string }>,
  });
  const rows = history.data ?? [];
  return <EnterprisePageShell title="Product Price History" eyebrow="AUDIT AND CONTROL">
    <section className="panel enterprise-table-panel">
      <div className="enterprise-toolbar"><div className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product or SKU" /></div></div>
      {history.isPending ? <LoadingRows /> : history.isError ? <ErrorBanner message={getErrorMessage(history.error)} onRetry={() => void history.refetch()} /> :
        rows.length ? <EnterpriseTable
          columns={["Product", "Branch", "Buying price", "Selling price", "Changed by", "Reason", "Date"]}
          rows={rows.map((row) => [`${row.productName} (${row.sku})`, row.branch || "All branches",
            `${row.previousBuyingPrice ?? "—"} → ${row.newBuyingPrice ?? "—"}`,
            `${row.previousSellingPrice ?? "—"} → ${row.newSellingPrice ?? "—"}`,
            row.changedBy || "System", row.reason || "—", new Date(row.createdAt).toLocaleString("en-KE")])}
        /> : <EmptyState title="No price changes" detail="Authorized buying or selling price changes will appear here." />}
    </section>
  </EnterprisePageShell>;
}

function NotificationsPage({ user }: { user: User }) {
  const query = useQueryClient();
  const isAdmin = user.roles.includes("admin");
  const notifications = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get("/notifications")).data as Array<{ recipient: string; status: string; providerMessageId: string | null; attempts: number; error: string | null; createdAt: string }>,
  });
  const settings = useQuery({
    queryKey: ["notification-settings"],
    queryFn: async () => (await api.get("/notifications/settings")).data,
    enabled: isAdmin,
  });
  const saveSettings = useMutation({
    mutationFn: (values: { enabled: boolean; dailySummaryEnabled: boolean; lowStockEnabled: boolean; receiptEnabled: boolean }) =>
      api.put("/notifications/settings", values),
    onSuccess: () => void query.invalidateQueries({ queryKey: ["notification-settings"] }),
  });
  const send = useMutation({
    mutationFn: async (values: { recipient: string; message: string }) => (await api.post("/notifications/send", values)).data,
  });
  const rows = notifications.data ?? [];
  const settingsData = settings.data as {
    enabled: boolean; dailySummaryEnabled: boolean; lowStockEnabled: boolean; receiptEnabled: boolean;
  } | null | undefined;
  return <EnterprisePageShell title="Notification Centre" eyebrow="WHATSAPP AND DELIVERY" actions={isAdmin ? <button className="button button-dark" onClick={() => document.querySelector<HTMLInputElement>("#notification-recipient")?.focus()}><Smartphone size={15} /> New message</button> : undefined}>
    {send.isError && <div role="alert" className="error-banner">{getErrorMessage(send.error)}</div>}
    {saveSettings.isError && <ErrorBanner message={getErrorMessage(saveSettings.error)} onRetry={() => {
      if (settingsData) saveSettings.mutate(settingsData);
    }} />}
    <div className="enterprise-grid notification-center-grid">
      {isAdmin && <section className="panel enterprise-form-panel">
        <div className="panel-heading"><div><div className="eyebrow">AUTOMATIC RECEIPTS</div><h2>Sale notifications</h2></div></div>
        {settings.isPending ? <LoadingRows /> : settings.isError ? <ErrorBanner message={getErrorMessage(settings.error)} onRetry={() => void settings.refetch()} /> : settingsData && <>
          <label className="notification-setting"><input type="checkbox" checked={settingsData.enabled} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ ...settingsData, enabled: event.target.checked })} /><span><strong>Enable WhatsApp notifications</strong><small>Master switch for automatic messages.</small></span></label>
          <label className="notification-setting"><input type="checkbox" checked={settingsData.receiptEnabled} disabled={saveSettings.isPending || !settingsData.enabled} onChange={(event) => saveSettings.mutate({ ...settingsData, receiptEnabled: event.target.checked })} /><span><strong>Send receipt after each successful sale</strong><small>Requires a customer with a phone number on the sale.</small></span></label>
          <p className="operation-note">Configure the server-side WhatsApp credentials and an approved receipt template in the server environment. Provider acceptance is recorded as “sent”; it is not a delivery confirmation.</p>
        </>}
      </section>}
      {isAdmin && <section className="panel enterprise-form-panel">
        <div className="panel-heading"><div><div className="eyebrow">WHATSAPP</div><h2>Send notification</h2></div></div>
        <form className="enterprise-form" onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          send.mutate({ recipient: String(values.get("recipient") ?? ""), message: String(values.get("message") ?? "") });
          event.currentTarget.reset();
        }}>
          <label>Recipient phone<input id="notification-recipient" name="recipient" required placeholder="2547XXXXXXXX" /></label>
          <label>Message<textarea name="message" required rows={5} placeholder="Enter notification text" /></label>
          <button className="button button-dark" disabled={send.isPending || settings.isError}>{send.isPending ? "Sending…" : "Send WhatsApp"}</button>
        </form>
      </section>}
      <section className="panel enterprise-table-panel">
        <div className="panel-heading"><div><div className="eyebrow">DELIVERY HISTORY</div><h2>Messages</h2></div><span className="count-badge">{rows.length}</span></div>
        {notifications.isPending ? <LoadingRows /> : notifications.isError ? <ErrorBanner message={getErrorMessage(notifications.error)} onRetry={() => void notifications.refetch()} /> : rows.length ? <EnterpriseTable
          columns={["Recipient", "Status", "Provider ID", "Attempts", "Sent"]}
          rows={rows.map((row) => [row.recipient, <span key="status" className={`enterprise-status ${row.status === "delivered" || row.status === "sent" ? "success" : row.status === "failed" ? "danger" : "warning"}`}>{row.status}</span>, row.providerMessageId || "—", row.attempts, new Date(row.createdAt).toLocaleString("en-KE")])}
        /> : <EmptyState title="No notifications" detail="Delivery attempts will appear here." />}
      </section>
    </div>
  </EnterprisePageShell>;
}

function ElectronicReceiptsPage() {
  const [search, setSearch] = useState("");
  const receipts = useQuery({
    queryKey: ["electronic-receipts", search],
    queryFn: async () => (await api.get("/electronic-receipts", { params: { q: search || undefined } })).data as Array<{ id: number; saleId: number; receiptNumber: string; total: string; cashier: string; branch: string; createdAt: string }>,
  });
  const rows = receipts.data ?? [];
  return <EnterprisePageShell title="Electronic Receipts" eyebrow="DIGITAL DOCUMENTS">
    <section className="panel enterprise-table-panel">
      <div className="enterprise-toolbar"><div className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search receipt or cashier" /></div></div>
      {receipts.isPending ? <LoadingRows /> : receipts.isError ? <ErrorBanner message={getErrorMessage(receipts.error)} onRetry={() => void receipts.refetch()} /> :
        rows.length ? <EnterpriseTable
          columns={["Receipt", "Branch", "Cashier", "Total", "Date", "Action"]}
          rows={rows.map((row) => [row.receiptNumber, row.branch, row.cashier, money(row.total),
            new Date(row.createdAt).toLocaleString("en-KE"),
            <Link key="view" className="enterprise-link" to={`/sales`}>View sale</Link>])}
        /> : <EmptyState title="No electronic receipts" detail="Completed sales generate digital receipts automatically." />}
    </section>
  </EnterprisePageShell>;
}

function ComparisonsPage() {
  const [from, setFrom] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 29);
    return dateInputValue(date);
  });
  const [to, setTo] = useState(() => dateInputValue(new Date()));
  const report = useQuery({
    queryKey: ["enterprise-comparison", from, to],
    queryFn: async () => (await api.get("/reports/summary", { params: { from, to } })).data,
  });
  const data = report.data as { summary?: { revenue?: string; grossProfit?: string | null; netProfit?: string | null; expenses?: string; transactions?: number; averageOrder?: string } } | undefined;
  const summary = data?.summary;
  return <EnterprisePageShell title="Business Comparisons" eyebrow="PERFORMANCE ANALYTICS" actions={<div className="enterprise-date-controls"><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>}>
    {report.isError ? <ErrorBanner message={getErrorMessage(report.error)} onRetry={() => void report.refetch()} /> : <div className="enterprise-comparison-grid">
      <div className="enterprise-kpi"><span>Revenue</span><strong>{summary ? money(summary.revenue ?? "0") : "—"}</strong></div>
      <div className="enterprise-kpi"><span>Gross profit</span><strong>{summary?.grossProfit ? money(summary.grossProfit) : "Not costed"}</strong></div>
      <div className="enterprise-kpi"><span>Net profit</span><strong>{summary?.netProfit ? money(summary.netProfit) : "Not costed"}</strong></div>
      <div className="enterprise-kpi"><span>Transactions</span><strong>{summary?.transactions ?? "—"}</strong></div>
      <div className="enterprise-kpi"><span>Expenses</span><strong>{summary ? money(summary.expenses ?? "0") : "—"}</strong></div>
    </div>}
  </EnterprisePageShell>;
}

function MetricCard({ label, value, caption, icon, tone, loading }: { label: string; value: string; caption: string; icon: ReactNode; tone?: string; loading: boolean }) {
  return <div className={`metric-card ${tone ?? ""}`}><div className="metric-top"><span>{label}</span><div className="metric-icon">{icon}</div></div><div className={`metric-value ${loading ? "skeleton" : ""}`}>{loading ? " " : value}</div><div className="metric-caption">{caption}</div></div>;
}

function MobileScannerPage() {
  const [pairingId, setPairingId] = useState("");
  const [scannerToken, setScannerToken] = useState("");
  const [scannerMode, setScannerMode] = useState<"pos" | "registration">("pos");
  const [pairingMessage, setPairingMessage] = useState("Scan the pairing QR code displayed on the POS computer.");
  const [cameraError, setCameraError] = useState("");
  const [manualBarcode, setManualBarcode] = useState("");
  const [result, setResult] = useState<{ id?: string; barcode: string; status: string; message: string; productName?: string } | null>(null);
  const [desktopConnected, setDesktopConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [sending, setSending] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastDetectedCodeRef = useRef("");
  const lastDetectionAtRef = useRef(0);
  const sendingRef = useRef(false);
  const awaitingResultRef = useRef(false);
  const pendingResultIdRef = useRef("");
  const pollingRef = useRef(false);

  useEffect(() => {
    let active = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const pair = fragment.get("pair");
    const separator = pair?.indexOf(".") ?? -1;
    if (pair && separator > 0) {
      const id = pair.slice(0, separator);
      const pairToken = pair.slice(separator + 1);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      void api.post<{ scannerToken: string; mode: "pos" | "registration" }>(`/pos/scanner/pair/${id}`, { token: pairToken })
        .then(({ data }) => {
          if (!active) return;
          window.sessionStorage.setItem(`smart-pos-scanner:${id}`, data.scannerToken);
          window.sessionStorage.setItem("smart-pos-scanner-id", id);
          window.sessionStorage.setItem("smart-pos-scanner-mode", data.mode);
          setPairingId(id);
          setScannerToken(data.scannerToken);
          setScannerMode(data.mode);
          setPairingMessage(data.mode === "registration"
            ? "Phone paired. Connect to the Products form to identify a new product."
            : "Phone paired. Connect to the POS computer to scan products.");
        })
        .catch((error: unknown) => setPairingMessage(getErrorMessage(error)));
    } else {
      const id = window.sessionStorage.getItem("smart-pos-scanner-id") ?? "";
      const token = id ? window.sessionStorage.getItem(`smart-pos-scanner:${id}`) ?? "" : "";
      const savedMode = window.sessionStorage.getItem("smart-pos-scanner-mode");
      if (id && token) {
        setPairingId(id);
        setScannerToken(token);
        setScannerMode(savedMode === "registration" ? "registration" : "pos");
        setPairingMessage(savedMode === "registration"
          ? "Reconnecting to your product registration session…"
          : "Reconnecting to your paired POS session…");
      }
    }
    return () => { active = false; };
  }, []);

  const sendBarcode = async (barcode: string) => {
    if (!pairingId || !scannerToken || sendingRef.current || awaitingResultRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const { data } = await api.post<{ accepted: boolean; duplicate: boolean; scanId?: string }>(
        `/pos/scanner/${pairingId}/scans`,
        { barcode },
        { headers: { Authorization: `Bearer ${scannerToken}` } },
      );
      if (data.duplicate) {
        setPairingMessage("Duplicate camera read ignored. Move the camera away and scan again.");
      } else {
        if (data.scanId) {
          awaitingResultRef.current = true;
          pendingResultIdRef.current = data.scanId;
          setResult({ id: data.scanId, barcode, status: "pending", message: "Barcode sent. Waiting for POS…" });
        }
      }
      setCameraError("");
      setManualBarcode("");
    } catch (error) {
      awaitingResultRef.current = false;
      setCameraError(getErrorMessage(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  useEffect(() => {
    if (!pairingId || !scannerToken) return;
    let active = true;
    const checkConnection = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const { data } = await api.get<{
          connected: boolean;
          latestResult: { id: string; barcode: string; status: string; message: string; productName?: string } | null;
        }>(`/pos/scanner/${pairingId}/status`, { headers: { Authorization: `Bearer ${scannerToken}` } });
        if (!active) return;
        setCameraError("");
        setDesktopConnected(data.connected);
        if (data.latestResult?.id === pendingResultIdRef.current) {
          awaitingResultRef.current = false;
          pendingResultIdRef.current = "";
          setResult(data.latestResult);
        }
      } catch (error) {
        if (active) {
          setDesktopConnected(false);
          setCameraError(getErrorMessage(error));
        }
      } finally {
        pollingRef.current = false;
      }
    };
    void checkConnection();
    const timer = window.setInterval(() => void checkConnection(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pairingId, scannerToken]);

  const reconnect = async () => {
    setCameraError("");
    try {
      const { data } = await api.post<{ connected: boolean }>(
        `/pos/scanner/${pairingId}/reconnect`,
        {},
        { headers: { Authorization: `Bearer ${scannerToken}` } },
      );
      setCameraError("");
      setDesktopConnected(data.connected);
      setPairingMessage(data.connected ? "Connected to the POS computer." : "Paired, but the POS computer is not responding.");
    } catch (error) {
      setDesktopConnected(false);
      setCameraError(getErrorMessage(error));
    }
  };

  const disconnect = async () => {
    if (!pairingId || !scannerToken) return;
    try {
      await api.post(`/pos/scanner/${pairingId}/disconnect`, {}, {
        headers: { Authorization: `Bearer ${scannerToken}` },
      });
    } catch (error) {
      setCameraError(getErrorMessage(error));
      return;
    }
    stopCamera();
    window.sessionStorage.removeItem(`smart-pos-scanner:${pairingId}`);
    window.sessionStorage.removeItem("smart-pos-scanner-id");
    window.sessionStorage.removeItem("smart-pos-scanner-mode");
    awaitingResultRef.current = false;
    pendingResultIdRef.current = "";
    setPairingId("");
    setScannerToken("");
    setDesktopConnected(false);
    setResult(null);
    setPairingMessage("Scanner disconnected. Scan a new pairing QR code to connect again.");
  };

  const stopCamera = () => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanning(false);
  };
  const startCamera = async () => {
    setCameraError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access requires this scanner page to be opened over trusted HTTPS.");
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    try {
      const { BrowserMultiFormatReader: Reader } = await import("@zxing/browser");
      readerRef.current ??= new Reader();
      const permissionStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      permissionStream.getTracks().forEach((track) => track.stop());
      const videoDevices = await Reader.listVideoInputDevices();
      const rearCamera = videoDevices.find((device) => /back|rear|environment/i.test(device.label))
        ?? videoDevices.at(-1);
      const controls = await readerRef.current.decodeFromVideoDevice(
        rearCamera?.deviceId,
        video,
        (decoded) => {
          if (!decoded) {
            if (lastDetectedCodeRef.current && Date.now() - lastDetectionAtRef.current > 800) {
              lastDetectedCodeRef.current = "";
            }
            return;
          }
          const barcode = decoded.getText().trim();
          if (!barcode) return;
          lastDetectionAtRef.current = Date.now();
          if (sendingRef.current || awaitingResultRef.current || barcode === lastDetectedCodeRef.current) return;
          lastDetectedCodeRef.current = barcode;
          void sendBarcode(barcode);
        },
      );
      controlsRef.current = controls;
      setScanning(true);
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "The rear camera could not be started.");
      setScanning(false);
    }
  };

  useEffect(() => () => controlsRef.current?.stop(), []);

  return (
    <main className="mobile-scanner-page">
      <header className="mobile-scanner-header">
        <span className="brand-mark">s</span>
        <div><strong>Smart POS</strong><small>Phone barcode scanner</small></div>
        <span className={`scanner-connection ${desktopConnected ? "connected" : ""}`}><i />{desktopConnected ? "Laptop connected" : "Laptop offline"}</span>
      </header>
      <section className="mobile-scanner-card">
        <div className="eyebrow"><span className="eyebrow-dot" /> {scannerMode === "registration" ? "PRODUCT REGISTRATION" : "WIRELESS CHECKOUT"}</div>
        <h1>{scannerMode === "registration" ? "Identify a product" : "Scan a product"}</h1>
        <p>{pairingMessage}</p>
        {!window.isSecureContext && <div className="scanner-notice">Open this page through trusted HTTPS to allow Android camera access.</div>}
        {!pairingId || !scannerToken ? (
          <div className="scanner-waiting"><QrCode size={34} /><strong>Pair with the POS computer</strong><span>Open the phone-scanner option at the register and scan its one-time QR code.</span></div>
        ) : <>
          <div className="scanner-video-wrap">
            <video ref={videoRef} muted playsInline autoPlay aria-label="Live barcode camera preview" />
            {scanning && <div className="scanner-target" aria-hidden="true"><i /></div>}
            {!scanning && <div className="scanner-camera-placeholder"><Camera size={30} /><span>Rear camera is stopped</span></div>}
          </div>
          <div className="scanner-controls">
            {!scanning
              ? <button className="scanner-primary" onClick={() => void startCamera()}><Camera size={17} /> Start scanning</button>
              : <button className="scanner-stop" onClick={stopCamera}><CameraOff size={17} /> Stop scanning</button>}
            <button className="scanner-reconnect" onClick={() => void reconnect()}><RefreshCw size={16} /> Reconnect</button>
            <button className="scanner-reconnect" onClick={() => void disconnect()}><X size={16} /> Disconnect</button>
          </div>
          <form className="scanner-manual-form" onSubmit={(event) => {
            event.preventDefault();
            const barcode = manualBarcode.trim();
            if (barcode) void sendBarcode(barcode);
          }}>
            <label htmlFor="manual-mobile-barcode">Enter barcode manually</label>
            <div><input id="manual-mobile-barcode" value={manualBarcode} onChange={(event) => setManualBarcode(event.target.value)} autoComplete="off" maxLength={64} /><button disabled={!manualBarcode.trim() || sending || awaitingResultRef.current}>{sending ? "Sending…" : "Send"}</button></div>
          </form>
          <div className={`scanner-feedback ${result?.status === "added" ? "success" : result?.status === "unknown" || cameraError ? "failure" : ""}`} role="status" aria-live="polite">
            {cameraError ? cameraError : result
              ? <>{result.message}{result.productName && <small>{result.productName} · {result.barcode}</small>}</>
              : desktopConnected ? "Ready. Point the rear camera at a product barcode." : "Waiting for the POS computer to connect."}
          </div>
        </>}
        <p className="scanner-format-note">EAN-13 · EAN-8 · UPC-A · UPC-E · Code 128</p>
      </section>
    </main>
  );
}

function PosEntryPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ["pos-session"],
    queryFn: async () => (await api.get<{ cashier: { id: number; name: string; username: string } }>("/pos/session")).data.cashier,
    retry: false,
  });
  useEffect(() => {
    if (axios.isAxiosError(session.error) && session.error.response?.status === 401) {
      void queryClient.resetQueries({ queryKey: ["me"] });
    }
  }, [queryClient, session.error]);
  const logout = useMutation({
    mutationFn: async () => {
      await api.post("/pos/logout");
      await api.post("/auth/logout");
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/");
    },
  });
  if (session.isPending) {
    return <div className="boot-screen"><div className="brand-mark">s</div><span>Opening your register…</span></div>;
  }
  if (session.isError) return (
    <main className="pos-login-page">
      <section className="pos-login-card" role="alert">
        <div className="pos-login-brand"><span className="brand-mark">s</span><div><strong>Smart POS</strong><small>Register unavailable</small></div></div>
        <h1>Could not open the register</h1>
        <p>{getErrorMessage(session.error)}</p>
        <button className="pos-login-submit" onClick={() => void session.refetch()}>Try again</button>
      </section>
    </main>
  );
  return <PosPage user={user} cashier={session.data} onLogout={() => logout.mutate()} />;
}

function PosSignOutConfirmation({
  unfinishedItemCount, onConfirm, onCancel,
}: { unfinishedItemCount: number; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="pos-confirm-screen" role="dialog" aria-modal="true">
      <section className="pos-confirm-card">
        <span className="pos-confirm-eyebrow">POS SESSION</span>
        <h2>Sign out of POS?</h2>
        {unfinishedItemCount > 0
          ? <p>Your unfinished sale has {unfinishedItemCount} item(s). It will be cleared when you sign out.</p>
          : <p>This will end your POS session and return you to your authorized workspace.</p>}
        <div className="pos-confirm-actions">
          <button className="confirm" onClick={onConfirm}>Confirm sign out</button>
          <button className="cancel" onClick={onCancel}>Continue POS</button>
        </div>
      </section>
    </div>
  );
}

function PosPage({ user, cashier, onLogout }: { user: User; cashier: { id: number; name: string; username: string }; onLogout: () => void }) {
  const queryClient = useQueryClient();
  const canSell = user.roles.some((role) => ["admin", "manager", "cashier"].includes(role));
  const canViewTransactionHistory = user.modules?.includes("sales") === true
    && (user.roles.includes("admin")
      || user.modules?.includes("transaction_own") === true
      || user.modules?.includes("transaction_all") === true);
  const canViewTransactionDetails = user.modules?.includes("transaction_details") === true;
  const [posConnectionStatus, setPosConnectionStatus] = useState<"ONLINE" | "OFFLINE" | "SYNCING" | "SYNC FAILED">(
    typeof navigator !== "undefined" && navigator.onLine ? "ONLINE" : "OFFLINE",
  );
  const [presenceHeartbeatFailed, setPresenceHeartbeatFailed] = useState(false);
  const [pendingOfflineCount, setPendingOfflineCount] = useState(0);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<PosCartLine[]>([]);
  const [saleDiscount, setSaleDiscount] = useState("0.00");
  const [toast, setToast] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [openingCash, setOpeningCash] = useState("0.00");
  const [counterNumber, setCounterNumber] = useState("");
  const [amountPaid, setAmountPaid] = useState("");
  const [receiptWidth, setReceiptWidth] = useState<"58mm" | "80mm">("80mm");
  const [transactionHistoryOpen, setTransactionHistoryOpen] = useState(false);
  const [transactionSearch, setTransactionSearch] = useState("");
  const [transactionDate, setTransactionDate] = useState("");
  const [historyReceiptId, setHistoryReceiptId] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank_transfer" | "mpesa" | "split">("cash");
  const [bankReference, setBankReference] = useState("");
  const [cashAllocation, setCashAllocation] = useState("");
  const [cashConfirmOpen, setCashConfirmOpen] = useState(false);
  const [mpesaDialogOpen, setMpesaDialogOpen] = useState(false);
  const [mpesaPhone, setMpesaPhone] = useState("");
  const [mpesaDescription, setMpesaDescription] = useState("Retail purchase");
  const [mpesaPaymentId, setMpesaPaymentId] = useState<string | null>(null);
  const [mpesaError, setMpesaError] = useState("");
  const [bankVerification, setBankVerification] = useState<{
    id: number; amount: string; status: "pending" | "verified" | "rejected" | "used";
  } | null>(null);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [shiftCloseOpen, setShiftCloseOpen] = useState(false);
  const [actualCashCounted, setActualCashCounted] = useState("");
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const [closeShiftConfirmOpen, setCloseShiftConfirmOpen] = useState(false);
  const [phoneScannerOpen, setPhoneScannerOpen] = useState(false);
  const [phonePairing, setPhonePairing] = useState<{ id: string; qr: string; expiresAt: string } | null>(null);
  const [phonePairingError, setPhonePairingError] = useState("");
  const scannerRef = useRef<HTMLInputElement>(null);
  const saleTableRef = useRef<HTMLDivElement>(null);
  const lastPosActivityRef = useRef(Date.now());
  const lastPresenceSentAtRef = useRef(0);
  const lineIdRef = useRef(0);
  const isAddingProductRef = useRef(false);
  const scanInputRef = useRef({ value: "", lastInputAt: 0, rapidCharacters: 0 });
  const idempotencyRef = useRef<string | null>(null);
  const mpesaIdempotencyRef = useRef<string | null>(null);
  const mpesaSaleHandledRef = useRef<number | null>(null);
  const processedPhoneScansRef = useRef(new Set<string>());
  const phoneScanAcknowledgementsRef = useRef(new Map<string, {
    status: "added" | "unknown" | "rejected" | "error";
    message: string;
    productName?: string;
  }>());
  useEffect(() => {
    window.requestAnimationFrame(() => scannerRef.current?.focus());
  }, []);
  useEffect(() => {
    const markActive = () => { lastPosActivityRef.current = Date.now(); };
    const sendHeartbeat = async () => {
      if (!navigator.onLine) return;
      const active = lastPosActivityRef.current > lastPresenceSentAtRef.current;
      lastPresenceSentAtRef.current = lastPosActivityRef.current;
      try {
        await api.post("/pos/heartbeat", { active });
        setPresenceHeartbeatFailed(false);
      } catch {
        setPresenceHeartbeatFailed(true);
      }
    };
    window.addEventListener("pointerdown", markActive);
    window.addEventListener("keydown", markActive);
    window.addEventListener("touchstart", markActive);
    void sendHeartbeat();
    const interval = window.setInterval(() => void sendHeartbeat(), 20_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("touchstart", markActive);
    };
  }, []);
  useEffect(() => {
    if (!cart.length) return;
    if (saleTableRef.current) saleTableRef.current.scrollTop = saleTableRef.current.scrollHeight;
    scannerRef.current?.focus({ preventScroll: true });
  }, [cart.length]);
  useEffect(() => {
    const refreshOfflineCount = async () => {
      try {
        setPendingOfflineCount((await listOfflineSales()).filter((record) => record.status !== "syncing").length);
      } catch {
        setPendingOfflineCount(0);
      }
    };
    const synchronizeOfflineSales = async () => {
      setPosConnectionStatus("SYNCING");
      let remaining = 0;
      try {
        const records = await listOfflineSales();
        remaining = records.length;
        for (const record of records) {
          const syncingRecord = { ...record, status: "syncing" as const, attempts: record.attempts + 1 };
          await updateOfflineSale(syncingRecord);
          try {
            await api.post("/sync-monitor/offline-sales", record, {
              headers: { "Idempotency-Key": record.offlineId },
            });
            await removeOfflineSale(record.offlineId);
            remaining -= 1;
          } catch (error) {
            const failedRecord = {
              ...record,
              status: "failed" as const,
              attempts: syncingRecord.attempts,
              error: getErrorMessage(error),
            };
            await updateOfflineSale(failedRecord);
          }
        }
        setPendingOfflineCount(remaining);
        setPosConnectionStatus(remaining > 0 ? "SYNC FAILED" : "ONLINE");
      } catch {
        setPosConnectionStatus("SYNC FAILED");
        await refreshOfflineCount();
      }
    };
    const handleOnline = () => void synchronizeOfflineSales();
    const handleOffline = () => setPosConnectionStatus("OFFLINE");
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    void refreshOfflineCount();
    if (navigator.onLine) void synchronizeOfflineSales();
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);
  const activeShift = useQuery({
    queryKey: ["active-shift"],
    queryFn: async () => (await api.get<{ shift: { id: number; openingCash: string; openedAt: string; branchName: string } | null }>("/shifts/active")).data.shift,
  });
  const transactionHistoryFilters = {
    q: transactionSearch.trim(),
    from: transactionDate,
    to: transactionDate,
    status: "completed",
  };
  const transactionHistory = useQuery({
    queryKey: ["sales", transactionHistoryFilters],
    queryFn: async () => (await api.get<{ sales: Array<{
      id: number; receiptNumber: string; subtotal: string; discount: string; tax: string;
      total: string; amountPaid: string; changeDue: string; status: string; createdAt: string;
      cashier: string; paymentMethod: string | null;
    }> }>("/sales", { params: transactionHistoryFilters })).data.sales,
    enabled: canViewTransactionHistory && transactionHistoryOpen,
  });
  const historyReceipt = useQuery({
    queryKey: ["sale-detail", historyReceiptId],
    queryFn: async () => (await api.get<SaleReceipt>(`/sales/${historyReceiptId}`)).data,
    enabled: historyReceiptId !== null && canViewTransactionDetails,
  });
  const mpesaConfigQuery = useQuery({
    queryKey: ["mpesa-config"],
    queryFn: async () => (await api.get<{ mpesa: { configured: boolean; reason: string | null; requiresWholeShillings: boolean } }>("/mpesa/config")).data.mpesa,
    staleTime: 60_000,
    retry: false,
  });
  const shiftSummary = useQuery({
    queryKey: ["shift-close-summary"],
    queryFn: async () => (await api.get<{ summary: {
      totalSales: string; cashSales: string; cardSales: string; mobileMoneySales: string;
      bankTransferSales: string; refunds: string; transactionCount: number; expectedCash: string;
    } }>("/shifts/close-summary")).data.summary,
    enabled: shiftCloseOpen && Boolean(activeShift.data),
  });
  const closeShiftMutation = useMutation({
    mutationFn: () => api.post<{ expected: string; actual: string; variance: string }>("/shifts/close", { actualCash: actualCashCounted }),
    onSuccess: async () => {
      await api.post("/pos/logout").catch(() => undefined);
      window.location.assign("/");
    },
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });
  const heldSalesQuery = useQuery({
    queryKey: ["held-sales"],
    queryFn: async () => (await api.get<{ sales: Array<{
      id: number; holdNumber: string; items: Array<{ productId: number; quantity: string }>;
      discount: string; createdAt: string;
    }> }>("/sales/held")).data.sales,
  });
  const holdSaleMutation = useMutation({
    mutationFn: () => api.post("/sales/held", {
      discount: fromCents(discountAmountCents),
      items: aggregateCartItems(cart),
    }),
    onSuccess: () => {
      setCart([]);
      setSaleDiscount("0.00");
      setToast("Sale held successfully.");
      void queryClient.invalidateQueries({ queryKey: ["held-sales"] });
    },
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });
  const openShiftMutation = useMutation({
    mutationFn: async () => (await api.post<{ id: number; openingCash: string }>("/shifts/open", { openingCash, counterNumber })).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["active-shift"] }),
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });
  const productsQuery = useQuery({
    queryKey: ["products", search],
    queryFn: async () => (await api.get<{ products: Product[] }>("/products", { params: { search } })).data.products,
  });
  const createPhonePairing = useMutation({
    mutationFn: async () => {
      if (window.location.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
        throw new Error("Open the POS from a trusted HTTPS address reachable by the phone, then create the pairing QR code.");
      }
      const { data } = await api.post<{ id: string; pairToken: string; expiresAt: string }>("/pos/scanner/pairing");
      const scannerOrigin = import.meta.env.VITE_PUBLIC_APP_URL?.trim() || window.location.origin;
      const url = new URL("/mobile-scanner", scannerOrigin);
      if (url.protocol !== "https:") {
        throw new Error("The mobile scanner page must be hosted at an HTTPS address.");
      }
      url.hash = new URLSearchParams({ pair: `${data.id}.${data.pairToken}` }).toString();
      const { default: QRCode } = await import("qrcode");
      const qr = await QRCode.toDataURL(url.toString(), { width: 260, margin: 1, errorCorrectionLevel: "M" });
      return { id: data.id, qr, expiresAt: data.expiresAt };
    },
    onSuccess: (pairing) => {
      processedPhoneScansRef.current.clear();
      phoneScanAcknowledgementsRef.current.clear();
      setPhonePairing(pairing);
      setPhonePairingError("");
    },
    onError: (error) => setPhonePairingError(getErrorMessage(error)),
  });
  const disconnectPhoneScanner = useMutation({
    mutationFn: () => api.delete(`/pos/scanner/pairing/${phonePairing!.id}`),
    onSuccess: () => {
      processedPhoneScansRef.current.clear();
      phoneScanAcknowledgementsRef.current.clear();
      setPhonePairing(null);
      setPhonePairingError("");
      void queryClient.removeQueries({ queryKey: ["phone-scanner"] });
    },
    onError: (error) => setPhonePairingError(getErrorMessage(error)),
  });
  const phoneScannerQuery = useQuery({
    queryKey: ["phone-scanner", phonePairing?.id],
    queryFn: async () => (await api.get<{
      paired: boolean;
      scannerConnected: boolean;
      scans: Array<{ id: string; barcode: string; createdAt: number }>;
    }>(`/pos/scanner/pairing/${phonePairing!.id}/poll`)).data,
    enabled: Boolean(phonePairing),
    refetchInterval: 1200,
    retry: false,
  });
  const requestBankVerification = useMutation({
    mutationFn: async () => (await api.post<{ verification: BankTransferVerification }>("/bank-transfer-verifications", {
      reference: bankReference.trim(),
      amount: fromCents(paymentMethod === "split"
        ? payableCents - Math.round((Number(cashAllocation) || 0) * 100)
        : payableCents),
    })).data.verification,
    onSuccess: (verification) => {
      setBankVerification(verification);
      setCheckoutError("");
    },
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });
  const checkBankVerification = useMutation({
    mutationFn: async () => (await api.get<{ verification: BankTransferVerification }>("/bank-transfer-verifications/status", { params: { reference: bankReference.trim() } })).data.verification,
    onSuccess: (verification) => {
      setBankVerification(verification);
      setCheckoutError("");
    },
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });
  const checkout = useMutation({
    mutationFn: async () => {
      if (!idempotencyRef.current) idempotencyRef.current = createUuid();
      const cashAmountCents = Math.round((Number(cashAllocation) || 0) * 100);
      const bankAmountCents = payableCents - cashAmountCents;
      const payments = paymentMethod === "split"
        ? [
          { method: "cash" as const, amount: fromCents(cashAmountCents) },
          { method: "bank_transfer" as const, amount: fromCents(bankAmountCents), providerReference: bankReference.trim() },
        ]
        : [{
          method: paymentMethod,
          amount: fromCents(payableCents),
          ...(paymentMethod === "bank_transfer" ? { providerReference: bankReference.trim() } : {}),
        }];
      const body = {
        items: aggregateCartItems(cart),
        discount: fromCents(discountAmountCents),
        ...(["cash", "split"].includes(paymentMethod) ? { cashReceived: amountPaid } : {}),
        payments,
      };
      try {
        return {
          offlineQueued: false as const,
          sale: (await api.post<{ sale: { id: number; receiptNumber: string; total: string; status: string } }>("/sales", body, {
            headers: { "Idempotency-Key": idempotencyRef.current },
          })).data.sale,
        };
      } catch (error) {
        if (navigator.onLine || paymentMethod !== "cash") throw error;
        const record: OfflineSaleRecord = {
          offlineId: idempotencyRef.current,
          items: body.items,
          discount: body.discount,
          payments: [{ method: "cash", amount: fromCents(payableCents) }],
          cashReceived: amountPaid,
          recordedAt: new Date().toISOString(),
          status: "pending",
          attempts: 0,
        };
        await saveOfflineSale(record);
        return { offlineQueued: true as const, offlineId: record.offlineId };
      }
    },
    onSuccess: (result) => {
      if (result.offlineQueued) {
        setPosConnectionStatus("OFFLINE");
        setPendingOfflineCount((count) => count + 1);
        setToast("Cash sale saved offline. It is queued for server confirmation.");
        setCashConfirmOpen(false);
        setCheckoutError("");
        idempotencyRef.current = null;
        return;
      }
      const sale = result.sale;
      setToast(`Sale ${sale.receiptNumber} completed · Ready for a new sale.`);
      setCart([]);
      setSaleDiscount("0.00");
      setAmountPaid("");
      setPaymentMethod("cash");
      setBankReference("");
      setCashAllocation("");
      setBankVerification(null);
      setMpesaPaymentId(null);
      mpesaIdempotencyRef.current = null;
      mpesaSaleHandledRef.current = null;
      setCheckoutError("");
      idempotencyRef.current = null;
      setCashConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["sales"] });
      setTransactionHistoryOpen(false);
      window.requestAnimationFrame(() => scannerRef.current?.focus());
    },
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });
  const requestMpesaPayment = useMutation({
    mutationFn: async () => {
    if (!mpesaIdempotencyRef.current) mpesaIdempotencyRef.current = createUuid();
    return (await api.post<{ payment: MpesaPayment }>("/mpesa/payments", {
      items: aggregateCartItems(cart),
      discount: fromCents(discountAmountCents),
      phone: mpesaPhone.trim(),
      description: mpesaDescription.trim(),
    }, { headers: { "Idempotency-Key": mpesaIdempotencyRef.current } })).data.payment;
    },
    onSuccess: (payment) => {
    setMpesaPaymentId(payment.id);
    setMpesaError("");
    setCheckoutError("");
    },
    onError: (error) => setMpesaError(getErrorMessage(error)),
  });
  const mpesaPaymentQuery = useQuery({
    queryKey: ["mpesa-payment", mpesaPaymentId],
    queryFn: async () => (await api.get<{ payment: MpesaPayment }>(`/mpesa/payments/${mpesaPaymentId}`)).data,
    enabled: Boolean(mpesaPaymentId),
    refetchInterval: (query) => ["succeeded", "failed", "cancelled", "unknown"].includes(query.state.data?.payment.status ?? "")
    ? false
    : 2_500,
    retry: false,
  });
  const mpesaStatus = mpesaPaymentQuery.data?.payment.status;
  const mpesaPaymentUnresolved = Boolean(mpesaPaymentId)
    && !["succeeded", "failed", "cancelled"].includes(mpesaStatus ?? "");
  const cancelMpesaPayment = useMutation({
    mutationFn: async () => (await api.post(`/mpesa/payments/${mpesaPaymentId}/cancel`)).data,
    onSuccess: () => {
    setMpesaPaymentId(null);
    mpesaIdempotencyRef.current = null;
    setMpesaError("");
    setMpesaDialogOpen(false);
    setPaymentMethod("cash");
    },
    onError: (error) => setMpesaError(getErrorMessage(error)),
  });
  const completeMpesaSale = (saleId: number) => {
    setToast(`Sale #${saleId} completed · Ready for a new sale.`);
    setCart([]);
    setSaleDiscount("0.00");
    setAmountPaid("");
    setPaymentMethod("cash");
    setBankReference("");
    setCashAllocation("");
    setBankVerification(null);
    setMpesaDialogOpen(false);
    setMpesaPaymentId(null);
    setMpesaError("");
    mpesaIdempotencyRef.current = null;
    idempotencyRef.current = null;
    setTransactionHistoryOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["products"] });
    void queryClient.invalidateQueries({ queryKey: ["sales"] });
    window.requestAnimationFrame(() => scannerRef.current?.focus());
  };
  useEffect(() => {
    const payment = mpesaPaymentQuery.data?.payment;
    if (payment?.status === "succeeded" && payment.saleId && mpesaSaleHandledRef.current !== payment.saleId) {
      mpesaSaleHandledRef.current = payment.saleId;
      completeMpesaSale(payment.saleId);
    }
  }, [mpesaPaymentQuery.data?.payment.status, mpesaPaymentQuery.data?.payment.saleId]);
  const retrieveHeldSaleMutation = useMutation({
    mutationFn: (id: number) => api.post<{ sale: {
      items: Array<{ productId: number; quantity: string }>;
      discount: string;
    } }>(`/sales/held/${id}/retrieve`),
    onSuccess: async ({ data }) => {
      const { data: catalogue } = await api.get<{ products: Product[] }>("/products");
      const restored: PosCartLine[] = [];
      for (let index = 0; index < data.sale.items.length; index += 1) {
        const line = data.sale.items[index];
        const product = catalogue.products.find((candidate) => candidate.id === line.productId);
        if (product) restored.push({ lineId: ++lineIdRef.current, product, quantity: Number(line.quantity) });
      }
      setCart(restored);
      setSaleDiscount(data.sale.discount);
      setToast("Held sale retrieved.");
      void queryClient.invalidateQueries({ queryKey: ["held-sales"] });
    },
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });

  const addProduct = (product: Product) => {
    if (mpesaPaymentUnresolved) return false;
    if (Number(product.stock) < 1) {
      setCheckoutError(`${product.name} is out of stock.`);
      return false;
    }
    const quantityInCart = cart.reduce((sum, item) => item.product.id === product.id ? sum + item.quantity : sum, 0);
    if (quantityInCart >= Math.floor(Number(product.stock))) {
      setCheckoutError(`No more stock is available for ${product.name}.`);
      return false;
    }
    setCheckoutError("");
    const existing = cart.find((item) => item.product.id === product.id);
    if (existing) {
      setCart((current) => current.map((item) =>
        item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item));
    } else {
      const lineId = ++lineIdRef.current;
      setCart((current) => [...current, { lineId, product, quantity: 1 }]);
    }
    return true;
  };
  useEffect(() => {
    if (mpesaPaymentUnresolved) return;
    const pending = (phoneScannerQuery.data?.scans ?? [])
      .filter((scan) => !processedPhoneScansRef.current.has(scan.id)
        || phoneScanAcknowledgementsRef.current.has(scan.id))
      .slice(0, 1);
    if (!phonePairing || !pending.length) return;
    for (const scan of pending) processedPhoneScansRef.current.add(scan.id);
    void (async () => {
      for (const scan of pending) {
        let acknowledgement = phoneScanAcknowledgementsRef.current.get(scan.id);
        if (!acknowledgement) {
          try {
            const { data } = await api.get<{ product: Product | null }>("/pos/scanner/product", {
              params: { barcode: scan.barcode },
            });
            if (!data.product) {
              acknowledgement = { status: "unknown", message: "Product not found in inventory. Contact administrator." };
              setCheckoutError(acknowledgement.message);
            } else if (addProduct(data.product)) {
              const productLabel = [data.product.brand, data.product.packageSize].filter(Boolean).join(" · ");
              const productDetails = `${data.product.name}${productLabel ? ` (${productLabel})` : ""} · ${money(data.product.sellingPrice)} each · ${Number(data.product.stock).toLocaleString("en-KE", { maximumFractionDigits: 3 })} available before sale.`;
              acknowledgement = {
                status: "added",
                message: `${productDetails} Added to the sale.`,
                productName: data.product.name,
              };
              setToast(`${productDetails} Phone scan.`);
            } else {
              acknowledgement = {
                status: "rejected",
                message: `${data.product.name} could not be added. Check available stock on the POS.`,
                productName: data.product.name,
              };
            }
          } catch (error) {
            acknowledgement = { status: "error", message: getErrorMessage(error).slice(0, 200) };
            setCheckoutError(acknowledgement.message);
          }
          phoneScanAcknowledgementsRef.current.set(scan.id, acknowledgement);
        }
        try {
          await api.post(`/pos/scanner/pairing/${phonePairing.id}/ack`, {
            scanId: scan.id,
            ...acknowledgement,
          });
          phoneScanAcknowledgementsRef.current.delete(scan.id);
        } catch (error) {
          setCheckoutError(`Could not confirm the phone scan: ${getErrorMessage(error)}`);
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["phone-scanner", phonePairing.id] });
    })();
  }, [phoneScannerQuery.data, phonePairing, cart, queryClient, mpesaPaymentUnresolved]);
  const scan = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedSearchIndex((index) => Math.min(index + 1, Math.min((productsQuery.data?.length ?? 0) - 1, 7)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedSearchIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSearch("");
      setSelectedSearchIndex(0);
      scannerRef.current?.focus();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (isAddingProductRef.current) return;
    const code = search.trim();
    if (!code) {
      scannerRef.current?.focus();
      return;
    }
    isAddingProductRef.current = true;
    try {
      const rapidScan = scanInputRef.current.value === code && scanInputRef.current.rapidCharacters >= 6;
      const barcodeScan = /^(?:\d{8}|\d{12,13})$/.test(code) || rapidScan;
      let match: Product | undefined;
      if (barcodeScan) {
        const { data } = await api.get<{ product: Product | null }>("/pos/scanner/product", { params: { barcode: code } });
        match = data.product ?? undefined;
      } else {
        const { data } = await api.get<{ products: Product[] }>("/products", { params: { search: code } });
        const exact = data.products.find((product) => product.barcode === code || product.sku === code);
        match = exact ?? data.products[selectedSearchIndex] ?? data.products[0];
      }
      if (match) {
        if (addProduct(match)) {
          setSearch("");
          setSelectedSearchIndex(0);
        }
      } else {
        setCheckoutError(barcodeScan
          ? "Product not found in inventory. Contact administrator."
          : `No product found for “${code}”.`);
        setSearch("");
      }
    } catch (error) {
      setCheckoutError(getErrorMessage(error));
    } finally {
      window.requestAnimationFrame(() => {
        scannerRef.current?.focus({ preventScroll: true });
        isAddingProductRef.current = false;
        scanInputRef.current = { value: "", lastInputAt: 0, rapidCharacters: 0 };
      });
    }
  };
  const adjust = (lineId: number, amount: number) => setCart((current) => current
    .map((item) => item.lineId === lineId
      ? {
        ...item,
        quantity: Math.max(0, Math.min(
          item.quantity + amount,
          Math.floor(Number(item.product.stock)) - current.reduce(
            (sum, other) => other.product.id === item.product.id && other.lineId !== item.lineId ? sum + other.quantity : sum,
            0,
          ),
        )),
      }
      : item)
    .filter((item) => item.quantity > 0));
  const setLineQuantity = (lineId: number, quantity: number) => setCart((current) => current.map((item) => {
    if (item.lineId !== lineId) return item;
    const otherQuantity = current.reduce(
      (sum, other) => other.product.id === item.product.id && other.lineId !== item.lineId ? sum + other.quantity : sum,
      0,
    );
    const maxQuantity = Math.max(1, Math.floor(Number(item.product.stock)) - otherQuantity);
    return { ...item, quantity: Math.max(1, Math.min(Math.floor(quantity), maxQuantity)) };
  }));
  const subtotalCents = useMemo(() => cart.reduce((sum, item) =>
    sum + cents(item.product.sellingPrice) * item.quantity, 0), [cart]);
  const discountAmountCents = Math.min(subtotalCents, Math.max(0, cents(saleDiscount)));
  const taxCents = useMemo(() => {
    const discountFactor = subtotalCents > 0 ? (subtotalCents - discountAmountCents) / subtotalCents : 1;
    return cart.reduce((sum, item) => {
      const gross = cents(item.product.sellingPrice) * item.quantity;
      const taxable = Math.round(gross * discountFactor);
      return sum + Math.round(taxable * Number(item.product.taxRate) / 100);
    }, 0);
  }, [cart, subtotalCents, discountAmountCents]);
  const payableCents = subtotalCents - discountAmountCents + taxCents;
  const lineTotalCents = (item: PosCartLine) => {
    const gross = cents(item.product.sellingPrice) * item.quantity;
    const taxable = subtotalCents > 0
      ? Math.round(gross * (subtotalCents - discountAmountCents) / subtotalCents)
      : gross;
    return taxable + Math.round(taxable * Number(item.product.taxRate) / 100);
  };
  const amountPaidCents = Math.round((Number(amountPaid) || 0) * 100);
  const cashAllocationCents = Math.round((Number(cashAllocation) || 0) * 100);
  const validCashTender = /^\d{1,10}(?:\.\d{1,2})?$/.test(amountPaid.trim());
  const validCashAllocation = /^\d{1,10}(?:\.\d{1,2})?$/.test(cashAllocation.trim());
  const bankAllocationCents = paymentMethod === "split" ? payableCents - cashAllocationCents : payableCents;
  const balanceCents = Math.max(0, payableCents - amountPaidCents);
  const changeCents = Math.max(0, amountPaidCents - payableCents);
  const cashShareBalanceCents = Math.max(0, cashAllocationCents - amountPaidCents);
  const cashShareChangeCents = Math.max(0, amountPaidCents - cashAllocationCents);
  const bankTransferApprovedForAmount = bankVerification?.status === "verified"
    && bankVerification.amount === fromCents(bankAllocationCents);
  const canCompletePayment = paymentMethod === "cash"
    ? validCashTender && amountPaidCents >= payableCents
    : paymentMethod === "split"
      ? validCashAllocation && validCashTender
        && cashAllocationCents > 0 && bankAllocationCents > 0
        && amountPaidCents >= cashAllocationCents
        && Boolean(bankReference.trim())
        && bankTransferApprovedForAmount
      : paymentMethod === "bank_transfer"
        ? Boolean(bankReference.trim()) && bankTransferApprovedForAmount
        : false;
  const completeCheckout = () => {
    if (!canCompletePayment || !cart.length || !activeShift.data || mpesaPaymentUnresolved) return;
    if (paymentMethod === "cash") setCashConfirmOpen(true);
    else checkout.mutate();
  };
  const bankTransferControls = <>
    <label className="pos-payment-input"><span>Bank transaction reference</span><input value={bankReference} onChange={(event) => { setBankReference(event.target.value); setBankVerification(null); }} maxLength={100} autoComplete="off" placeholder="Enter bank transfer reference" disabled={mpesaPaymentUnresolved} /></label>
    <div className="bank-verification-amount"><span>Bank transfer portion</span><strong>{money(bankAllocationCents / 100)}</strong></div>
    <div className="bank-verification-actions">
      <button type="button" disabled={!cart.length || !activeShift.data || bankAllocationCents <= 0 || !bankReference.trim() || requestBankVerification.isPending || bankVerification?.status === "pending" || bankVerification?.status === "verified" || mpesaPaymentUnresolved} onClick={() => requestBankVerification.mutate()}>
        {requestBankVerification.isPending ? "Submitting…" : "Request admin verification"}
      </button>
      <button type="button" disabled={!bankReference.trim() || checkBankVerification.isPending} onClick={() => checkBankVerification.mutate()}>
        {checkBankVerification.isPending ? "Checking…" : "Check status"}
      </button>
    </div>
    {bankVerification && <div className={`bank-verification-status status-${bankVerification.status}`} role="status">
      {bankVerification.status === "verified"
        ? `Approved for ${money(bankVerification.amount)}.`
        : bankVerification.status === "pending"
          ? `Waiting for an administrator to verify ${money(bankVerification.amount)}.`
          : `Transfer status: ${bankVerification.status}.`}
      {bankVerification.status === "verified" && bankVerification.amount !== fromCents(bankAllocationCents) && " Payment portion changed; submit a new verification request for the exact amount."}
    </div>}
  </>;
  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "F2") {
        event.preventDefault();
        scannerRef.current?.focus();
        return;
      }
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "F3") { event.preventDefault(); scannerRef.current?.focus(); }
      if (event.key === "F4") { event.preventDefault(); scannerRef.current?.focus(); }
      if (event.key === "F5" && !mpesaPaymentUnresolved) { event.preventDefault(); setCart([]); setSaleDiscount("0.00"); setAmountPaid(""); setCheckoutError(""); }
      if (event.key === "F6") { event.preventDefault(); if (cart.length && !mpesaPaymentUnresolved) holdSaleMutation.mutate(); }
      if (event.key === "F7") { event.preventDefault(); if (!mpesaPaymentUnresolved) void heldSalesQuery.refetch(); }
      if (event.key === "F9") {
        event.preventDefault();
        if (canSell && cart.length && canCompletePayment && activeShift.data && !checkout.isPending) completeCheckout();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (cashConfirmOpen) setCashConfirmOpen(false);
        else if (!mpesaPaymentUnresolved && !mpesaPaymentId) { setCart([]); setSaleDiscount("0.00"); setAmountPaid(""); }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [cart.length, canSell, canCompletePayment, activeShift.data, checkout.isPending, holdSaleMutation, heldSalesQuery, cashConfirmOpen, mpesaPaymentUnresolved, mpesaPaymentId]);

  const actualCashNumber = Math.round((Number(actualCashCounted) || 0) * 100);
  const expectedCashNumber = Math.round(Number(shiftSummary.data?.expectedCash ?? 0) * 100);
  const cashDifferenceNumber = actualCashNumber - expectedCashNumber;

  if (shiftCloseOpen) {
    return (
      <section className="pos-close-screen">
        <header className="pos-dedicated-header">
          <div className="pos-header-brand"><strong>Smart POS</strong><span>{activeShift.data?.branchName ?? `Branch ${user.branchId}`}</span></div>
          <div className="pos-header-cashier"><span>Cashier</span><strong>{cashier.name}</strong></div>
          <div className="pos-header-shift"><span>Shift</span><strong className={activeShift.data ? "open" : "closed"}>{activeShift.data ? "OPEN" : "CLOSED"}</strong></div>
          <button className="pos-header-action" onClick={() => setShiftCloseOpen(false)}>Back to POS</button>
          <button className="pos-header-signout" onClick={() => setSignOutConfirmOpen(true)}>Sign Out</button>
        </header>
        {signOutConfirmOpen && <PosSignOutConfirmation
          unfinishedItemCount={cart.reduce((sum, item) => sum + item.quantity, 0)}
          onConfirm={onLogout}
          onCancel={() => setSignOutConfirmOpen(false)}
        />}
        <main className="pos-close-content">
          <div className="pos-close-title"><span>SHIFT CHANGE</span><h1>Close cashier shift</h1><p>{cashier.name} · {activeShift.data ? `Shift opened ${new Date(activeShift.data.openedAt).toLocaleString("en-KE")}` : "No active shift"}</p></div>
          {shiftSummary.isPending ? <div className="pos-close-loading">Loading shift totals…</div> : shiftSummary.data ? (
            <>
              <div className="pos-close-metrics">
                <div><span>Total sales</span><strong>{money(shiftSummary.data.totalSales)}</strong></div>
                <div><span>Cash sales</span><strong>{money(shiftSummary.data.cashSales)}</strong></div>
                <div><span>Card sales</span><strong>{money(shiftSummary.data.cardSales)}</strong></div>
                <div><span>Mobile money</span><strong>{money(shiftSummary.data.mobileMoneySales)}</strong></div>
                <div><span>Bank transfer</span><strong>{money(shiftSummary.data.bankTransferSales)}</strong></div>
                <div><span>Refunds</span><strong>{money(shiftSummary.data.refunds)}</strong></div>
                <div><span>Transactions</span><strong>{shiftSummary.data.transactionCount}</strong></div>
              </div>
              <div className="pos-close-reconcile">
                <div><span>Expected cash</span><strong>{money(shiftSummary.data.expectedCash)}</strong></div>
                <label>Actual cash counted<input inputMode="decimal" value={actualCashCounted} onChange={(event) => setActualCashCounted(event.target.value)} placeholder="0.00" /></label>
                <div className={cashDifferenceNumber < 0 ? "negative" : cashDifferenceNumber > 0 ? "positive" : ""}><span>Cash difference</span><strong>{money(cashDifferenceNumber / 100)}</strong></div>
              </div>
              <div className="pos-close-actions">
                <button className="pos-close-confirm" disabled={!/^\d{1,10}(\.\d{1,2})?$/.test(actualCashCounted) || closeShiftMutation.isPending} onClick={() => {
                  setCloseShiftConfirmOpen(true);
                }}>{closeShiftMutation.isPending ? "Closing shift…" : "Confirm & close shift"}</button>
                <button className="pos-close-back" onClick={() => setShiftCloseOpen(false)}>Return to POS</button>
              </div>
            </>
          ) : <div className="pos-close-loading">No open shift is available.</div>}
          {closeShiftConfirmOpen && <div className="pos-confirm-screen pos-close-confirm-dialog" role="dialog" aria-modal="true">
            <section className="pos-confirm-card">
              <span className="pos-confirm-eyebrow">SHIFT CONFIRMATION</span>
              <h2>Close this shift?</h2>
              <p>The counted cash and calculated difference will be recorded. Continue to the dashboard after confirmation.</p>
              <div className="pos-confirm-actions">
                <button className="confirm" disabled={closeShiftMutation.isPending} onClick={() => closeShiftMutation.mutate()}>{closeShiftMutation.isPending ? "Recording…" : "Confirm close"}</button>
                <button className="cancel" onClick={() => setCloseShiftConfirmOpen(false)}>Cancel</button>
              </div>
            </section>
          </div>}
        </main>
      </section>
    );
  }

  return (
    <section className="pos-page pos-desktop">
      <header className="pos-dedicated-header">
        <div className="pos-header-brand"><strong>Smart POS</strong><span>{activeShift.data?.branchName ?? `Branch ${user.branchId}`}</span></div>
        <div className="pos-header-cashier"><span>Cashier</span><strong>{cashier.name}</strong></div>
        <div className="pos-header-time"><span>{new Date().toLocaleDateString("en-KE", { weekday: "short", year: "numeric", month: "short", day: "2-digit" })}</span><strong>{new Date().toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}</strong></div>
        <div className="pos-header-shift"><span>Shift</span><strong className={activeShift.data ? "open" : "closed"}>{activeShift.data ? "OPEN" : "CLOSED"}</strong></div>
        <button className="pos-header-action" onClick={() => setShiftCloseOpen(true)}>Shift Change</button>
        <button className="pos-header-signout" onClick={() => setSignOutConfirmOpen(true)}>Sign Out</button>
      </header>
      {signOutConfirmOpen && <PosSignOutConfirmation
        unfinishedItemCount={cart.reduce((sum, item) => sum + item.quantity, 0)}
        onConfirm={onLogout}
        onCancel={() => setSignOutConfirmOpen(false)}
      />}
      {toast && <div role="status" className="success-banner"><ShieldCheck size={17} /> {toast}<button onClick={() => setToast("")} aria-label="Dismiss"><X size={15} /></button></div>}
      {checkoutError && <ErrorBanner message={checkoutError} onRetry={() => setCheckoutError("")} />}
      {activeShift.isError && <ErrorBanner message={getErrorMessage(activeShift.error)} onRetry={() => void activeShift.refetch()} />}
      {phoneScannerOpen && <div className="pos-confirm-screen phone-pairing-screen" role="dialog" aria-modal="true" aria-labelledby="phone-pairing-title">
        <section className="phone-pairing-card">
          <button className="phone-pairing-close" aria-label="Close phone scanner pairing" onClick={() => setPhoneScannerOpen(false)}><X size={18} /></button>
          <span className="pos-confirm-eyebrow">WIRELESS PRODUCT ENTRY</span>
          <h2 id="phone-pairing-title">Connect your phone scanner</h2>
          <p>Connect your Android phone over any internet connection by scanning this one-time QR code. Scanned products are added to this cashier’s current sale.</p>
          {phonePairingError && <div className="pos-login-error" role="alert">{phonePairingError}</div>}
          {phonePairing && phoneScannerQuery.data?.paired ? <div className={`phone-pairing-status ${phoneScannerQuery.data.scannerConnected ? "connected" : ""}`}>
            <Smartphone size={19} /><div><strong>{phoneScannerQuery.data.scannerConnected ? "Phone scanner connected" : "Phone paired"}</strong><span>{phoneScannerQuery.data.scannerConnected ? "Ready to receive barcode scans." : "Waiting for the phone scanner to reconnect."}</span></div>
          </div> : phonePairing && Date.now() < Date.parse(phonePairing.expiresAt) ? <img className="phone-pairing-qr" src={phonePairing.qr} alt="One-time pairing QR code for the Android phone scanner" /> : <div className="phone-pairing-placeholder"><QrCode size={28} /><span>{createPhonePairing.isPending ? "Creating secure pairing code…" : "Create a short-lived pairing QR code."}</span></div>}
          {phoneScannerQuery.isError && <div className="pos-login-error" role="alert">{getErrorMessage(phoneScannerQuery.error)}</div>}
          <div className="phone-pairing-actions">
            {phoneScannerQuery.data?.paired && <button className="cancel" disabled={disconnectPhoneScanner.isPending} onClick={() => disconnectPhoneScanner.mutate()}>
              {disconnectPhoneScanner.isPending ? "Disconnecting…" : "Disconnect phone"}
            </button>}
            {!phonePairing || Date.now() >= Date.parse(phonePairing.expiresAt) || phoneScannerQuery.data?.paired
              ? <button className="confirm" disabled={createPhonePairing.isPending} onClick={() => createPhonePairing.mutate()}>
                {createPhonePairing.isPending ? "Creating…" : phoneScannerQuery.data?.paired ? "Pair another phone" : "Create pairing QR"}
              </button>
              : <span>Pairing code expires at {new Date(phonePairing.expiresAt).toLocaleTimeString("en-KE")}.</span>}
            <button className="cancel" onClick={() => setPhoneScannerOpen(false)}>Close</button>
          </div>
          <small className="phone-pairing-security">Secure HTTPS is required for camera access. The QR code is single-use and expires after 90 seconds.</small>
        </section>
      </div>}
      <div className="pos-layout">
        <div className="pos-catalog">
          {productsQuery.isError && <ErrorBanner message={getErrorMessage(productsQuery.error)} onRetry={() => void productsQuery.refetch()} />}
          <div className="pos-sale-table-wrap" ref={saleTableRef}>
            <table className="pos-sale-table">
              <thead><tr><th>No.</th><th>Product code</th><th>Product name</th><th>Qty</th><th>Unit price</th><th>Total</th><th>Action</th></tr></thead>
              <tbody>
                {cart.map(({ lineId, product, quantity }, index) => <tr className="pos-product-row" key={lineId}>
                  <td>{index + 1}</td><td className="pos-product-code">{product.sku}</td><td className="pos-product-name">{product.name}{(product.brand || product.packageSize) && <small className="pos-product-meta">{[product.brand, product.packageSize].filter(Boolean).join(" · ")}</small>}</td>
                  <td><div className="pos-table-qty"><button disabled={mpesaPaymentUnresolved} onClick={() => adjust(lineId, -1)}>−</button><input disabled={mpesaPaymentUnresolved} value={quantity} onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) setLineQuantity(lineId, next);
                  }} /><button disabled={mpesaPaymentUnresolved} onClick={() => adjust(lineId, 1)}>+</button></div></td>
                  <td>{money(product.sellingPrice)}</td>
                  <td>{money(lineTotalCents({ lineId, product, quantity }) / 100)}</td>
                  <td><button className="pos-row-remove" disabled={mpesaPaymentUnresolved} onClick={() => setCart((current) => current.filter((item) => item.lineId !== lineId))}><X size={14} /></button></td>
                </tr>)}
                <tr className="pos-search-row">
                  <td className="pos-search-cell" colSpan={7}>
                    <input
                      ref={scannerRef}
                      className="pos-search-input"
                      aria-label={`Product entry row ${cart.length + 1}; scan barcode or search products`}
                      disabled={mpesaPaymentUnresolved}
                      autoComplete="off"
                      autoFocus
                      spellCheck={false}
                      value={search}
                      onKeyDown={scan}
                      onChange={(event) => {
                        const value = event.target.value;
                        const now = performance.now();
                        const previous = scanInputRef.current;
                        const addedCharacters = Math.max(0, value.length - previous.value.length);
                        scanInputRef.current = {
                          value,
                          lastInputAt: now,
                          rapidCharacters: value.startsWith(previous.value) && value.length > previous.value.length
                            && now - previous.lastInputAt <= 40
                            ? previous.rapidCharacters + addedCharacters
                            : addedCharacters,
                        };
                        setSearch(value);
                        setSelectedSearchIndex(0);
                      }}
                    />
                    {search.trim() && <div className="pos-search-results">
                      {(productsQuery.data ?? []).slice(0, 8).map((product, index) => <button key={product.id} className={index === selectedSearchIndex ? "selected" : ""} disabled={mpesaPaymentUnresolved} onMouseEnter={() => setSelectedSearchIndex(index)} onClick={() => {
                        if (addProduct(product)) {
                          setSearch("");
                          setSelectedSearchIndex(0);
                          window.requestAnimationFrame(() => scannerRef.current?.focus({ preventScroll: true }));
                        }
                      }}>
                        <span><strong>{product.name}</strong><small>{product.sku} · {product.category}</small></span>
                        <b>{money(product.sellingPrice)}</b>
                      </button>)}
                      {!productsQuery.isPending && !productsQuery.data?.length && <div className="pos-search-empty">No matching product.</div>}
                    </div>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="pos-actions">
            <button disabled={mpesaPaymentUnresolved} onClick={() => { setCart([]); setSaleDiscount("0.00"); setAmountPaid(""); setCheckoutError(""); }}><Trash2 size={17} /> Clear <small>(F5)</small></button>
            <button onClick={() => { if (cart.length) holdSaleMutation.mutate(); }} disabled={!cart.length || holdSaleMutation.isPending || mpesaPaymentUnresolved}><Pause size={17} /> Hold sale <small>(F6)</small></button>
            <button disabled={mpesaPaymentUnresolved} onClick={() => void heldSalesQuery.refetch()}><Printer size={17} /> Retrieve <small>(F7)</small></button>
            <button disabled><Boxes size={17} /> Open drawer <small>(F8)</small></button>
            <button disabled={mpesaPaymentUnresolved} onClick={() => {
              setPhoneScannerOpen(true);
              setPhonePairingError("");
              if (!phonePairing) createPhonePairing.mutate();
            }}><Smartphone size={17} /> Phone scanner</button>
            {canViewTransactionHistory && <button
              type="button"
              aria-expanded={transactionHistoryOpen}
              onClick={() => setTransactionHistoryOpen((open) => !open)}
            ><ReceiptText size={17} /> {transactionHistoryOpen ? "Hide history" : "Transaction history"}</button>}
          </div>
          {heldSalesQuery.data?.length ? <div className="pos-held-strip">
            {heldSalesQuery.data.map((sale) => <button key={sale.id} onClick={() => retrieveHeldSaleMutation.mutate(sale.id)}>
              <strong>{sale.holdNumber}</strong><span>{sale.items.length} lines</span><b>Retrieve</b>
            </button>)}
          </div> : null}
        </div>
        <aside className="pos-payment-panel">
          <div className="pos-payment-heading"><span>Transaction summary</span><b>{cart.reduce((sum, item) => sum + item.quantity, 0)} items</b></div>
          <div className="pos-payment-grid">
            <div><span>Subtotal</span><strong>{money(subtotalCents / 100)}</strong></div>
            <div className="pos-discount-summary"><label htmlFor="sale-discount">Discount</label><input id="sale-discount" type="number" min="0" max={subtotalCents / 100} step="0.01" value={saleDiscount} onChange={(event) => setSaleDiscount(event.target.value)} onBlur={() => setSaleDiscount(fromCents(discountAmountCents))} inputMode="decimal" disabled={mpesaPaymentUnresolved} /></div>
            <div><span>VAT</span><strong>{money(taxCents / 100)}</strong></div>
            <div className="payable"><span>Total payable</span><strong>{money(payableCents / 100)}</strong></div>
          </div>
          {paymentMethod === "cash" ? <>
            <label className="pos-payment-input"><span>Amount received</span><input value={amountPaid} onChange={(event) => setAmountPaid(event.target.value)} inputMode="decimal" placeholder="0.00" disabled={mpesaPaymentUnresolved} /></label>
            <div className="pos-payment-change"><span>{changeCents > 0 ? "Change due" : "Balance"}</span><strong>{money((changeCents > 0 ? changeCents : balanceCents) / 100)}</strong></div>
          </> : paymentMethod === "split" ? <>
            <label className="pos-payment-input"><span>Cash portion</span><input value={cashAllocation} onChange={(event) => { setCashAllocation(event.target.value); setBankVerification(null); }} inputMode="decimal" placeholder="0.00" disabled={mpesaPaymentUnresolved} /></label>
            <label className="pos-payment-input"><span>Cash received</span><input value={amountPaid} onChange={(event) => setAmountPaid(event.target.value)} inputMode="decimal" placeholder="0.00" disabled={mpesaPaymentUnresolved} /></label>
            <div className="pos-payment-change"><span>{cashShareChangeCents > 0 ? "Cash change due" : "Cash balance"}</span><strong>{money((cashShareChangeCents > 0 ? cashShareChangeCents : cashShareBalanceCents) / 100)}</strong></div>
            {bankTransferControls}
          </> : paymentMethod === "bank_transfer" ? bankTransferControls : (
            <div className="mpesa-payment-hint">Enter the customer’s phone number in the M-Pesa payment window to request payment.</div>
          )}
          <div className="pos-payment-methods">
            <button className={paymentMethod === "cash" ? "active" : ""} type="button" disabled={mpesaPaymentUnresolved} onClick={() => setPaymentMethod("cash")}>Cash</button>
            <button className={paymentMethod === "mpesa" ? "active" : ""} type="button" disabled={mpesaPaymentUnresolved} onClick={() => { setPaymentMethod("mpesa"); setMpesaDialogOpen(true); setMpesaError(""); }}>M-Pesa</button>
            <button type="button" disabled title="Configure and verify a payment provider before enabling">Card</button>
            <button className={paymentMethod === "bank_transfer" ? "active" : ""} type="button" disabled={mpesaPaymentUnresolved} onClick={() => setPaymentMethod("bank_transfer")}>Bank transfer</button>
            <button className={paymentMethod === "split" ? "active" : ""} type="button" disabled={mpesaPaymentUnresolved} title="Split between cash and an administrator-verified bank transfer." onClick={() => setPaymentMethod("split")}>Split</button>
          </div>
          <div className="payment-setup-note">
            {paymentMethod === "bank_transfer" || paymentMethod === "split"
              ? "Bank transfers require administrator verification before the sale is completed."
              : paymentMethod === "mpesa"
                ? mpesaConfigQuery.data?.configured
                  ? "M-Pesa is verified by Daraja before the sale is completed."
                  : "Daraja credentials and a public HTTPS callback are required to accept M-Pesa."
                : "Card payments remain unavailable until a verified card provider is configured."}
          </div>
          <div className="pos-payment-actions">
            <button className="complete" disabled={!canSell || !cart.length || !canCompletePayment || checkout.isPending || !activeShift.data || mpesaPaymentUnresolved} onClick={completeCheckout}>{checkout.isPending ? "Processing…" : "Complete Sale"} <span>F9</span></button>
            <button className="hold" disabled={!cart.length || holdSaleMutation.isPending || mpesaPaymentUnresolved} onClick={() => holdSaleMutation.mutate()}>Hold Sale <span>F6</span></button>
            <button className="cancel" disabled={mpesaPaymentUnresolved} onClick={() => {
              setCart([]);
              setSaleDiscount("0.00");
              setAmountPaid("");
              setCheckoutError("");
              if (mpesaStatus === "failed" || mpesaStatus === "cancelled") {
                setMpesaPaymentId(null);
                mpesaIdempotencyRef.current = null;
              }
            }}>Cancel Sale <span>Esc</span></button>
          </div>
          {!canSell ? <div className="checkout-footnote">Your role cannot complete sales.</div>
            : activeShift.isError ? <div className="checkout-footnote">Shift availability could not be checked.</div>
              : activeShift.isPending ? <div className="checkout-footnote">Checking cashier shift…</div>
                : activeShift.data ? <div className="checkout-footnote"><ShieldCheck size={14} /> Stock is updated atomically</div>
                  : <div className="shift-needed"><span>Start a cashier shift.</span><label>Opening cash<input value={openingCash} inputMode="decimal" onChange={(event) => setOpeningCash(event.target.value)} /></label><label>Counter / till<input maxLength={40} value={counterNumber} onChange={(event) => setCounterNumber(event.target.value)} placeholder="Optional" /></label><button className="shift-open-button" onClick={() => openShiftMutation.mutate()}>{openShiftMutation.isPending ? "Opening…" : "Open shift"}</button></div>}
        </aside>
      </div>
      {canViewTransactionHistory && transactionHistoryOpen && <section className="pos-history-panel" aria-labelledby="pos-history-title">
        <div className="pos-history-heading">
          <div><span>RECENT SALES</span><h2 id="pos-history-title">Transaction History</h2></div>
          <div className="pos-history-filters">
            <label><span>Receipt number</span><input
              type="search"
              value={transactionSearch}
              onChange={(event) => setTransactionSearch(event.target.value)}
              placeholder="Search receipt"
              aria-label="Search transaction history by receipt number"
            /></label>
            <label><span>Transaction date</span><input
              type="date"
              value={transactionDate}
              onChange={(event) => setTransactionDate(event.target.value)}
              aria-label="Filter transaction history by date"
            /></label>
          </div>
        </div>
        {transactionHistory.isError && <ErrorBanner
          message={getErrorMessage(transactionHistory.error)}
          onRetry={() => void transactionHistory.refetch()}
        />}
        {historyReceipt.isError && <ErrorBanner
          message={getErrorMessage(historyReceipt.error)}
          onRetry={() => void historyReceipt.refetch()}
        />}
        {historyReceiptId !== null && historyReceipt.isPending && <div className="pos-history-loading" role="status">Loading receipt…</div>}
        <div className="pos-history-table-wrap">
          <table className="pos-history-table">
            <thead><tr><th>RECEIPT</th><th>DATE / TIME</th><th>PAYMENT</th><th>TOTAL</th><th>ACTION</th></tr></thead>
            <tbody>{transactionHistory.data?.map((sale) => <tr key={sale.id}>
              <td><strong>{sale.receiptNumber}</strong></td>
              <td>{new Date(sale.createdAt).toLocaleString("en-KE")}</td>
              <td>{sale.paymentMethod?.replaceAll(",", " / ").replaceAll("_", " ") ?? "—"}</td>
              <td>{money(sale.total)}</td>
              <td>{canViewTransactionDetails && <button
                type="button"
                className="small-action"
                onClick={() => setHistoryReceiptId(sale.id)}
              >View details / receipt</button>}</td>
            </tr>)}</tbody>
          </table>
          {transactionHistory.isPending && <div className="pos-history-loading">Loading transactions…</div>}
          {!transactionHistory.isPending && !transactionHistory.isError && !transactionHistory.data?.length
            && <EmptyState title="No completed transactions" detail="Completed sales for this account will appear here." />}
        </div>
      </section>}
      <footer className="pos-statusbar">
        <span><i /> Ready for new sale...</span>
        <time>{new Date().toLocaleString("en-KE")}</time>
        {presenceHeartbeatFailed && <b className="pos-network-status status-sync-failed">Presence update unavailable</b>}
        <b className={`pos-network-status status-${posConnectionStatus.toLowerCase().replace(" ", "-")}`}>
          ● {posConnectionStatus}{pendingOfflineCount > 0 ? ` · ${pendingOfflineCount} pending` : ""}
        </b>
      </footer>
      {cashConfirmOpen && <div className="pos-confirm-screen cash-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="cash-confirm-title">
        <section className="pos-confirm-card">
          <span className="pos-confirm-eyebrow">CASH PAYMENT</span>
          <h2 id="cash-confirm-title">Confirm cash received</h2>
          <div className="cash-confirm-summary">
            <div><span>Total payable</span><strong>{money(payableCents / 100)}</strong></div>
            <div><span>Amount received</span><strong>{money(amountPaidCents / 100)}</strong></div>
            <div><span>Change due</span><strong>{money(changeCents / 100)}</strong></div>
          </div>
          <p>Confirm that you received the cash amount shown. The sale will be saved and the register will be ready for the next sale.</p>
          <div className="pos-confirm-actions">
            <button className="confirm" disabled={checkout.isPending} onClick={() => checkout.mutate()}>{checkout.isPending ? "Recording…" : "Confirm payment"}</button>
            <button className="cancel" disabled={checkout.isPending} onClick={() => setCashConfirmOpen(false)}>Back</button>
          </div>
        </section>
      </div>}
      {mpesaDialogOpen && <div className="pos-confirm-screen mpesa-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="mpesa-payment-title">
        <section className="mpesa-payment-card">
          <button
            type="button"
            className="mpesa-payment-close"
            aria-label="Close M-Pesa payment"
            disabled={mpesaPaymentUnresolved}
            onClick={() => setMpesaDialogOpen(false)}
          ><X size={17} /></button>
          <span className="pos-confirm-eyebrow">M-PESA CHECKOUT</span>
          <h2 id="mpesa-payment-title">Request customer payment</h2>
          <p className="mpesa-payment-intro">The customer will receive an STK Push on their phone. Do not mark the sale paid until Daraja verifies the payment.</p>
          <label>Customer phone number
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              pattern="(?:07[0-9]{8}|2547[0-9]{8})"
              placeholder="07XXXXXXXX or 2547XXXXXXXX"
              value={mpesaPhone}
              onChange={(event) => setMpesaPhone(event.target.value)}
              disabled={Boolean(mpesaPaymentId)}
              required
            />
          </label>
          <label>Transaction amount
            <input value={money(payableCents / 100)} readOnly />
          </label>
          <label>Payment description
            <input maxLength={13} value={mpesaDescription} onChange={(event) => setMpesaDescription(event.target.value)} disabled={Boolean(mpesaPaymentId)} />
          </label>
          {mpesaConfigQuery.data?.configured === false && <div className="mpesa-modal-notice" role="alert">
            {mpesaConfigQuery.data.reason ?? "Daraja is not configured on the server."} Add server-side Daraja credentials and a reachable HTTPS callback URL.
          </div>}
          {mpesaConfigQuery.isError && <div className="mpesa-modal-notice" role="alert">M-Pesa availability could not be checked. Retry before accepting a payment.</div>}
          {!Number.isInteger(payableCents / 100) && cart.length > 0 && <div className="mpesa-modal-notice" role="alert">
            Daraja STK Push accepts whole Kenyan shillings. Use cash or an approved split for totals with cents.
          </div>}
          {mpesaError && <div className="mpesa-modal-notice" role="alert">{mpesaError}</div>}
          {mpesaPaymentQuery.isError && <div className="mpesa-modal-notice" role="alert">Payment status could not be checked. Retry status check before taking another payment.</div>}
          {mpesaPaymentQuery.data?.payment && <div className={`mpesa-payment-status status-${mpesaPaymentQuery.data.payment.status}`} role="status">
            <strong>
              {mpesaPaymentQuery.data.payment.status === "succeeded" ? "Payment successful and verified"
                : mpesaPaymentQuery.data.payment.status === "failed" ? "Payment failed"
                  : mpesaPaymentQuery.data.payment.status === "unknown" ? "Request outcome unknown"
                    : mpesaPaymentQuery.data.payment.status === "verifying" ? "Verifying with Daraja…"
                      : "Processing"}
            </strong>
            <span>{mpesaPaymentQuery.data.payment.status === "pending"
              ? "Ask the customer to enter their M-Pesa PIN on their phone."
              : mpesaPaymentQuery.data.payment.status === "unknown"
                ? "Do not resend the request. Check the phone and payment status before accepting another method."
                : mpesaPaymentQuery.data.payment.status === "failed"
                  ? mpesaPaymentQuery.data.payment.error ?? "The customer did not complete the payment."
                  : mpesaPaymentQuery.data.payment.status === "verifying"
                    ? "The callback is being checked against Daraja. The sale is not complete yet."
                    : mpesaPaymentQuery.data.payment.status === "succeeded"
                      ? "Payment confirmed. The register is ready for the next sale."
                      : "Waiting for payment confirmation."}</span>
            {mpesaPaymentQuery.data.payment.receiptNumber && <small>M-Pesa code: {mpesaPaymentQuery.data.payment.receiptNumber}</small>}
          </div>}
          <div className="mpesa-payment-actions">
            {!mpesaPaymentId
              ? <button
                className="confirm"
                disabled={
                  !mpesaConfigQuery.data?.configured
                  || mpesaConfigQuery.isLoading
                  || !/^(?:07[0-9]{8}|2547[0-9]{8})$/.test(mpesaPhone.trim())
                  || !mpesaDescription.trim()
                  || !cart.length
                  || !activeShift.data
                  || !Number.isInteger(payableCents / 100)
                  || requestMpesaPayment.isPending
                }
                onClick={() => requestMpesaPayment.mutate()}
              >{requestMpesaPayment.isPending ? "Sending request…" : "Send payment request"}</button>
              : mpesaPaymentQuery.data?.payment.status === "failed"
                ? <>
                  <button className="confirm" onClick={() => {
                    setMpesaPaymentId(null);
                    mpesaIdempotencyRef.current = null;
                    requestMpesaPayment.reset();
                    setMpesaError("");
                  }}>Retry payment</button>
                  <button className="cancel" disabled={cancelMpesaPayment.isPending} onClick={() => cancelMpesaPayment.mutate()}>
                    {cancelMpesaPayment.isPending ? "Cancelling…" : "Cancel request"}
                  </button>
                </>
                : mpesaPaymentQuery.data?.payment.status === "succeeded"
                  ? <button className="confirm" onClick={() => {
                    const saleId = mpesaPaymentQuery.data?.payment.saleId;
                    if (saleId) completeMpesaSale(saleId);
                  }}>Continue to POS</button>
                  : <button className="cancel" disabled={mpesaPaymentQuery.isFetching} onClick={() => void mpesaPaymentQuery.refetch()}>
                    {mpesaPaymentQuery.isFetching ? "Checking…" : "Check payment status"}
                  </button>}
            <button className="cancel" disabled={mpesaPaymentUnresolved} onClick={() => setMpesaDialogOpen(false)}>Close</button>
          </div>
        </section>
      </div>}
      {historyReceipt.data && <ReceiptDialog
        receipt={historyReceipt.data}
        width={receiptWidth}
        onWidthChange={setReceiptWidth}
        onClose={() => setHistoryReceiptId(null)}
        allowPrinting={user.modules?.includes("transaction_reprint") === true}
      />}
    </section>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="error-banner"><span>{message}</span><button onClick={onRetry}>Dismiss</button></div>;
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-state-icon"><ShoppingBasket size={19} /></div><strong>{title}</strong><span>{detail}</span></div>;
}
function LoadingRows() {
  return <div className="loading-rows">{[1, 2, 3].map((item) => <div key={item}><i /><span /><b /></div>)}</div>;
}

export default App;
