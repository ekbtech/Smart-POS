import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpDown, ArrowUpRight, Boxes, CalendarDays, ChevronDown, CircleDollarSign,
  Command, LayoutDashboard, LogOut, PackagePlus, Plus, Search, ShieldCheck,
  ShoppingBasket, ShoppingCart, TrendingUp, X, Users, Truck, Banknote, ReceiptText, RotateCcw, Download,
  Pause, Printer, Trash2, Upload,
} from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useEffect } from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { KeyboardEvent, ReactNode } from "react";
import { z } from "zod";
import {
  api, getErrorMessage, type BranchReport, type DashboardSummary, type Product, type User,
} from "./api";

const ReportsCharts = lazy(() => import("./ReportsCharts"));

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
  items: Array<{ id: number; sku: string; name: string; quantity: string; unitPrice: string; lineTotal: string }>;
  payments: Array<{ method: string; amount: string; status: string; reference: string | null }>;
};
type BankTransferVerification = {
  id: number; amount: string; status: "pending" | "verified" | "rejected" | "used";
};
const aggregateCartItems = (items: PosCartLine[]) => {
  const quantities = new Map<number, number>();
  for (const item of items) quantities.set(item.product.id, (quantities.get(item.product.id) ?? 0) + item.quantity);
  return Array.from(quantities, ([productId, quantity]) => ({ productId, quantity: String(quantity) }));
};

function PermissionRoute({ module, user, children }: { module: string; user: User; children: ReactNode }) {
  if (user.modules?.includes(module)) return <>{children}</>;
  return <Navigate to="/" replace />;
}

function App() {
  const query = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => (await api.get<{ user: User }>("/auth/me")).data.user,
  });
  if (me.isPending) return <div className="boot-screen"><div className="brand-mark">s</div><span>Opening your workspace…</span></div>;
  if (!me.data) return <LoginPage onLogin={(user) => {
    query.setQueryData(["me"], user);
  }} />;
  return (
    <Routes>
      <Route element={<AppShell user={me.data} />}>
        <Route index element={<PermissionRoute module="dashboard" user={me.data}><DashboardPage user={me.data} /></PermissionRoute>} />
        <Route path="/pos" element={<PermissionRoute module="pos" user={me.data}><PosEntryPage user={me.data} /></PermissionRoute>} />
        <Route path="/products" element={<PermissionRoute module="products" user={me.data}><ProductsPage user={me.data} /></PermissionRoute>} />
        <Route path="/inventory" element={<PermissionRoute module="inventory" user={me.data}><InventoryPage user={me.data} /></PermissionRoute>} />
        <Route path="/suppliers" element={<PermissionRoute module="suppliers" user={me.data}><SuppliersPage user={me.data} /></PermissionRoute>} />
        <Route path="/purchases" element={<PermissionRoute module="purchases" user={me.data}><PurchasesPage user={me.data} /></PermissionRoute>} />
        <Route path="/customers" element={<PermissionRoute module="customers" user={me.data}><CustomersPage user={me.data} /></PermissionRoute>} />
        <Route path="/staff" element={<PermissionRoute module="employees" user={me.data}><StaffPage user={me.data} /></PermissionRoute>} />
        <Route path="/shifts" element={<PermissionRoute module="shifts" user={me.data}><ShiftsPage user={me.data} /></PermissionRoute>} />
        <Route path="/expenses" element={<PermissionRoute module="expenses" user={me.data}><ExpensesPage user={me.data} /></PermissionRoute>} />
        <Route path="/reports" element={<PermissionRoute module="reports" user={me.data}><ReportsPage user={me.data} /></PermissionRoute>} />
        <Route path="/sales" element={<PermissionRoute module="sales" user={me.data}><SalesPage user={me.data} /></PermissionRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
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
      const routeMap: Record<string, string> = {
        dashboard: "/", pos: "/pos", sales: "/sales", products: "/products",
        inventory: "/inventory", purchases: "/purchases", suppliers: "/suppliers",
        customers: "/customers", employees: "/staff", expenses: "/expenses",
        shifts: "/shifts", reports: "/reports", permissions: "/staff",
        settings: "/staff", audit: "/staff",
      };
      let landing = "/";
      if (user.roles.includes("cashier") && user.modules?.includes("pos")) {
        landing = "/pos";
      } else if (user.defaultLanding) {
        const moduleId = user.defaultLanding.replace("/", "");
        if (user.modules?.includes(moduleId)) landing = user.defaultLanding;
      }
      if (!landing || landing === "/" && !user.modules?.includes("dashboard")) {
        const fallback = user.modules?.find((moduleId) => routeMap[moduleId]);
        landing = fallback ? routeMap[fallback] : "/";
      }
      navigate(landing);
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
          <div className="secure-note"><ShieldCheck size={15} /> Secure access to your Smart POS account</div>
        </div>
        <footer className="login-footer">Smart POS · Retail management</footer>
      </section>
    </main>
  );
}

function AppShell({ user }: { user: User }) {
  const location = useLocation();
  const query = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: () => { query.clear(); window.location.assign("/"); },
  });
  const isPos = location.pathname.startsWith("/pos");
  const isProducts = location.pathname.startsWith("/products");
  const pageLabels: Record<string, string> = {
    "/inventory": "Inventory", "/suppliers": "Suppliers", "/purchases": "Purchasing",
    "/customers": "Customers", "/shifts": "Cashier shifts", "/expenses": "Expenses", "/sales": "Sales & returns",
    "/staff": "Team", "/reports": "Reports",
  };
  const pageLabel = pageLabels[location.pathname];
  if (isPos) {
    return (
      <div className="pos-only-app">
        <Outlet />
      </div>
    );
  }
  return (
    <div className={`app-frame ${isPos ? "is-pos" : ""}`}>
      <aside className="sidebar">
        <Link to="/" className="brand"><span className="brand-mark">s</span><span>smart<strong>pos</strong></span></Link>
        <div className="branch-switcher"><div className="branch-avatar">M</div><div><strong>Main branch</strong><small>Retail workspace</small></div><ChevronDown size={15} /></div>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="nav-list">
          {user.modules?.includes("dashboard") && <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><LayoutDashboard size={18} /> Overview</NavLink>}
          {user.modules?.includes("pos") && <NavLink to="/pos" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><ShoppingBasket size={18} /> Point of sale <span className="nav-shortcut">F2</span></NavLink>}
          {user.modules?.includes("products") && <NavLink to="/products" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><Boxes size={18} /> Products</NavLink>}
          {user.modules?.includes("inventory") && <NavLink to="/inventory" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><ArrowLeftRight size={18} /> Inventory</NavLink>}
          {user.modules?.includes("purchases") && <NavLink to="/purchases" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><Truck size={18} /> Purchasing</NavLink>}
          {user.modules?.includes("suppliers") && <NavLink to="/suppliers" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><Users size={18} /> Suppliers</NavLink>}
          {user.modules?.includes("customers") && <NavLink to="/customers" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><Users size={18} /> Customers</NavLink>}
          {user.modules?.includes("employees") && <NavLink to="/staff" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><Users size={18} /> Team</NavLink>}
          {user.modules?.includes("shifts") && <NavLink to="/shifts" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><Banknote size={18} /> Cashier shifts</NavLink>}
          {user.modules?.includes("expenses") && <NavLink to="/expenses" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><ReceiptText size={18} /> Expenses</NavLink>}
          {user.modules?.includes("reports") && <NavLink to="/reports" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><TrendingUp size={18} /> Reports</NavLink>}
          {user.modules?.includes("sales") && <NavLink to="/sales" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><RotateCcw size={18} /> Sales & returns</NavLink>}
          {(user.modules?.includes("permissions") || user.modules?.includes("employees")) && <NavLink to="/staff" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}><ShieldCheck size={18} /> User management</NavLink>}
        </nav>
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
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{isPos ? "Point of sale" : isProducts ? "Products" : pageLabel ?? "Overview"}</strong></div>
          <div className="topbar-actions"><div className="online-status"><span /> WORKSPACE CONNECTED</div><button className="icon-button" onClick={() => logout.mutate()} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button></div>
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
  return (
    <section className="page-content">
      <div className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-dot" /> {greeting.toUpperCase()}</div><h1>{timeGreeting}, {user.name.split(" ")[0]}<span className="heading-period">.</span></h1><p>Here’s what’s happening across your store today.</p></div>
        <Link to="/pos" className="button button-dark"><ShoppingCart size={17} /> Start a sale <ArrowUpRight size={16} /></Link>
      </div>
      {summary.isError && <ErrorBanner message={getErrorMessage(summary.error)} onRetry={() => void summary.refetch()} />}
      <div className="metric-grid">
        <MetricCard label="TODAY'S SALES" value={data ? money(data.todaySales) : "—"} caption={`${data?.todayTransactions ?? 0} completed transactions`} icon={<CircleDollarSign size={19} />} tone="green" loading={summary.isPending} />
        <MetricCard label="ACTIVE PRODUCTS" value={data ? String(data.productCount).padStart(2, "0") : "—"} caption="Across your product catalogue" icon={<Boxes size={19} />} loading={summary.isPending} />
        <MetricCard label="NEEDS ATTENTION" value={data ? String(data.lowStockCount).padStart(2, "0") : "—"} caption="Products at or below reorder level" icon={<ArrowDownLeft size={19} />} tone="amber" loading={summary.isPending} />
        <div className="metric-card trend-card"><div className="metric-top"><span>YOUR WORKSPACE</span><TrendingUp size={18} /></div><div className="trend-value">In good order<span>.</span></div><div className="metric-caption"><span className="trend-indicator" /> Connected to live store data</div><div className="mini-bars" aria-hidden="true">{[31, 47, 38, 60, 49, 74, 56, 83, 67, 93, 72, 100].map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}</div></div>
      </div>
      <div className="dashboard-columns">
        <section className="panel sales-panel">
          <div className="panel-heading"><div><div className="eyebrow">THE LATEST</div><h2>Recent sales</h2></div><Link to="/pos" className="text-link">New sale <ArrowUpRight size={15} /></Link></div>
          {summary.isPending ? <LoadingRows /> : data?.recentSales.length ? <div className="sales-list">
            {data.recentSales.map((sale) => <div className="sale-row" key={sale.id}><div className="receipt-icon"><ShoppingBasket size={17} /></div><div className="sale-details"><strong>{sale.receiptNumber}</strong><small>{sale.cashier} · {new Date(sale.createdAt).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}</small></div><span className={`sale-complete ${sale.status !== "completed" ? "sale-pending" : ""}`}>{sale.status.replace("_", " ").toUpperCase()}</span><strong className="sale-amount">{money(sale.total)}</strong></div>)}
          </div> : <EmptyState title="No sales just yet" detail="Your completed transactions will appear here." /> }
        </section>
        <section className="panel stock-panel">
          <div className="panel-heading"><div><div className="eyebrow">STOCK WATCH</div><h2>Needs a restock</h2></div><span className="count-badge">{data?.lowStockCount ?? "—"}</span></div>
          {summary.isPending ? <LoadingRows /> : data?.lowStockProducts.length ? <div className="stock-list">
            {data.lowStockProducts.map((product) => <div className="stock-row" key={product.id}><div className="stock-dot" /><div className="stock-details"><strong>{product.name}</strong><small>Reorder at {Number(product.reorderLevel).toFixed(0)} units</small></div><span className="stock-qty">{Number(product.stock).toFixed(0)} <small>left</small></span></div>)}
          </div> : <EmptyState title="Stock looks healthy" detail="Low-stock items will be listed here." />}
          <div className="stock-footnote"><span className="status-dot" /> Inventory updates after each completed sale</div>
        </section>
      </div>
      <div className="bottom-note"><div className="note-icon"><ArrowLeftRight size={17} /></div><div><strong>A workspace that grows with you</strong><span>Products, inventory, and reporting tools are being added in thoughtful steps.</span></div><span className="note-status">FOUNDATION · LIVE</span></div>
    </section>
  );
}

const productCsvFields = ["sku", "barcode", "name", "category", "unit", "sellingPrice", "purchasePrice", "taxRate", "reorderLevel", "openingStock", "currentStock"];

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
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; failures: string[]; failureCount: number } | null>(null);
  const canManage = user.roles.some((role) => ["admin", "manager", "inventory_manager"].includes(role));
  const schema = z.object({
    sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, dashes, or underscores."),
    barcode: z.string().trim().max(64).optional(),
    name: z.string().trim().min(2).max(180),
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
    sku: "", barcode: "", name: "", category: "", unit: "piece",
    sellingPrice: "", purchasePrice: "", taxRate: "0", reorderLevel: "0", openingStock: "0",
  };
  const form = useForm<ProductForm>({ resolver: zodResolver(schema), defaultValues: emptyForm });
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
      }
      return imageError;
    },
    onSuccess: (imageError) => {
      form.reset(emptyForm);
      setImageFile(null);
      setFormError("");
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
        sku: values.sku, barcode: values.barcode || null, name: values.name, category: values.category,
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
      }
      return imageError;
    },
    onSuccess: (imageError) => {
      setEditingProduct(null);
      setImageFile(null);
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
          product.sku, product.barcode ?? "", product.name, product.category, product.unit,
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
          sku: value("sku"), barcode: value("barcode"), name: value("name"), category: value("category"),
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
        <div><div className="eyebrow"><span className="eyebrow-dot" /> CATALOGUE</div><h1>Product catalogue<span className="heading-period">.</span></h1><p>Manage product details, pricing, images and branch stock levels.</p></div>
        <div className="product-total"><PackagePlus size={17} /> {pagination?.total ?? "—"} PRODUCTS</div>
      </div>
      {success && <div role="status" className="success-banner">{success}<button onClick={() => setSuccess("")} aria-label="Dismiss"><X size={15} /></button></div>}
      {formError && <ErrorBanner message={formError} onRetry={() => setFormError("")} />}
      <section className="panel product-table-panel">
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
                  <div><strong>{product.name}</strong><small>{product.unit}</small></div>
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
                    setImageFile(null);
                    setFormError("");
                    form.reset({
                      sku: product.sku, barcode: product.barcode ?? "", name: product.name, category: product.category,
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
      {canManage && <section className="panel create-product-panel">
        <div className="create-heading"><div className="create-icon"><PackagePlus size={17} /></div><div><div className="eyebrow">CATALOGUE ACTION</div><h2>{editingProduct ? "Edit product" : "Add a product"}</h2></div></div>
        <p className="create-description">{editingProduct ? "Changes apply to this product across the shared catalogue." : "Add product details, an optional image and opening stock for this branch."}</p>
        <form className="product-form" onSubmit={form.handleSubmit((values) => { setFormError(""); setSuccess(""); editingProduct ? update.mutate(values) : create.mutate(values); })}>
          <div className="product-image-field"><span>Product image</span>
            <div className="product-image-editor">
              {imagePreview || (editingProduct?.hasImage ? `/api/products/${editingProduct.id}/image` : null)
                ? <img src={imagePreview ?? `/api/products/${editingProduct!.id}/image`} alt="Product preview" />
                : <span>{editingProduct?.name.slice(0, 1).toUpperCase() ?? "+"}</span>}
              <div><label className="small-action file-action"><Upload size={14} /> Choose image<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
                  setFormError("Choose a JPEG, PNG, or WebP image up to 5 MB.");
                } else {
                  setFormError("");
                  setImageFile(file);
                }
                event.currentTarget.value = "";
              }} /></label>
              <small>JPEG, PNG or WebP · maximum 5 MB</small>
              {editingProduct?.hasImage && !imageFile && <button type="button" className="small-action small-action-danger" onClick={() => removeImage.mutate(editingProduct.id)} disabled={removeImage.isPending}>{removeImage.isPending ? "Removing…" : "Remove current image"}</button>}</div>
            </div>
          </div>
          <label>Product name<input placeholder="e.g. Long-life milk 1L" {...form.register("name")} />{form.formState.errors.name && <small>{form.formState.errors.name.message}</small>}</label>
          <div className="form-pair">
            <label>SKU / product code<input placeholder="e.g. DAIR-012" {...form.register("sku")} />{form.formState.errors.sku && <small>Enter a valid SKU.</small>}</label>
            <label>Barcode<input placeholder="Optional" {...form.register("barcode")} /></label>
          </div>
          <div className="form-pair">
            <label>Category<input placeholder="e.g. Dairy" list="product-category-options" {...form.register("category")} /><datalist id="product-category-options">{categories.data?.map((item) => <option value={item} key={item} />)}</datalist></label>
            <label>Unit<select {...form.register("unit")}><option value="piece">Piece</option><option value="packet">Packet</option><option value="carton">Carton</option><option value="kg">Kilogram</option><option value="g">Gram</option><option value="litre">Litre</option><option value="ml">Millilitre</option></select></label>
          </div>
          <div className="form-pair">
            <label>Selling price (KSh)<input inputMode="decimal" placeholder="0.00" {...form.register("sellingPrice")} />{form.formState.errors.sellingPrice && <small>Enter a valid amount.</small>}</label>
            <label>Purchase cost (KSh)<input inputMode="decimal" placeholder="Optional" {...form.register("purchasePrice")} /></label>
          </div>
          <div className="form-pair">
            <label>Tax rate (%)<input inputMode="decimal" placeholder="0" {...form.register("taxRate")} />{form.formState.errors.taxRate && <small>Use a rate from 0 to 100.</small>}</label>
            <label>Reorder level<input inputMode="decimal" placeholder="0" {...form.register("reorderLevel")} /></label>
          </div>
          {!editingProduct && <label>Opening stock<input inputMode="decimal" placeholder="0" {...form.register("openingStock")} /></label>}
          <button className="button button-dark create-product-button" disabled={create.isPending || update.isPending}><Plus size={16} /> {editingProduct ? update.isPending ? "Updating…" : "Save changes" : create.isPending ? "Saving product…" : "Save product"} <ArrowUpRight size={15} /></button>
          {editingProduct ? <button type="button" className="small-action" onClick={() => { setEditingProduct(null); setImageFile(null); form.reset(emptyForm); }}>Cancel editing</button> : <div className="checkout-footnote"><ShieldCheck size={14} /> Opening stock is recorded in the stock ledger</div>}
        </form>
      </section>}
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
  const canCreate = user.roles.some((role) => ["admin", "manager"].includes(role));
  const isAdmin = user.roles.includes("admin");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "", email: "", password: "", role: "cashier",
    departmentId: "", jobTitle: "", phone: "", hiredAt: "",
  });
  const staff = useQuery({
    queryKey: ["staff", search],
    queryFn: async () => (await api.get<{ staff: Array<{
      id: number; name: string; email: string; isActive: boolean; createdAt: string;
      department: string | null; jobTitle: string | null; phone: string | null;
      hiredAt: string | null; roles: string[]; lastLogin: string | null;
    }> }>("/staff", { params: { search } })).data.staff,
  });
  const departments = useQuery({
    queryKey: ["staff-departments"],
    queryFn: async () => (await api.get<{ departments: Array<{ id: number; name: string }> }>("/staff/departments")).data.departments,
  });
  const refresh = () => {
    void query.invalidateQueries({ queryKey: ["staff"] });
    void query.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const create = useMutation({
    mutationFn: () => api.post("/staff", {
      ...form,
      departmentId: form.departmentId ? Number(form.departmentId) : null,
      hiredAt: form.hiredAt || null,
      phone: form.phone || undefined,
      jobTitle: form.jobTitle || undefined,
    }),
    onSuccess: () => {
      setForm({ name: "", email: "", password: "", role: "cashier", departmentId: "", jobTitle: "", phone: "", hiredAt: "" });
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
  const roleOptions = isAdmin
    ? ["admin", "manager", "cashier", "inventory_manager", "procurement_officer", "accountant"]
    : ["cashier", "inventory_manager", "procurement_officer", "accountant"];
  return <section className="page-content operations-page">
    <PageHeader eyebrow="EMPLOYEE MANAGEMENT" title="Team" detail="Manage branch staff accounts, roles, departments, and access status." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
    {(staff.isError || departments.isError) && <ErrorBanner message={getErrorMessage(staff.error ?? departments.error)} onRetry={() => { void staff.refetch(); void departments.refetch(); }} />}
    {canCreate && <section className="panel operation-form-panel">
      <div className="panel-heading"><div><div className="eyebrow">STAFF ONBOARDING</div><h2>Create a staff account</h2></div></div>
      <form className="operation-form staff-form" onSubmit={(event) => { event.preventDefault(); setError(""); create.mutate(); }}>
        <label>Full name<input required minLength={2} maxLength={150} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Work email<input type="email" required maxLength={254} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label>Initial password<input type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><small>At least 12 characters. Share securely with the employee.</small></label>
        <label>Role<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>{roleOptions.map((role) => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}</select></label>
        <label>Department<select value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}><option value="">Unassigned</option>{departments.data?.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
        <label>Job title<input maxLength={120} value={form.jobTitle} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} /></label>
        <label>Phone<input maxLength={40} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        <label>Hire date<input type="date" value={form.hiredAt} onChange={(event) => setForm({ ...form, hiredAt: event.target.value })} /></label>
        <button className="button button-dark" disabled={create.isPending || departments.isPending}>{create.isPending ? "Creating account…" : "Create staff account"}</button>
      </form>
    </section>}
    <section className="panel operation-table-panel">
      <div className="products-toolbar"><div><div className="eyebrow">BRANCH DIRECTORY</div><h2>Staff accounts</h2></div><label className="table-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or email" /></label></div>
      {staff.isPending ? <LoadingRows /> : <div className="product-table-wrap"><table className="product-table"><thead><tr><th>EMPLOYEE</th><th>ROLE</th><th>DEPARTMENT</th><th>LAST SIGN-IN</th><th>STATUS</th><th>ACCESS</th></tr></thead><tbody>
        {staff.data?.map((member) => <tr key={member.id}>
          <td><div className="table-product-name"><span>{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}</strong><small>{member.email}{member.jobTitle ? ` · ${member.jobTitle}` : ""}</small></div></div></td>
          <td className="sku-cell">{member.roles.map((role) => role.replaceAll("_", " ").toUpperCase()).join(", ") || "NO ROLE"}</td>
          <td>{member.department ?? "Unassigned"}</td>
          <td>{member.lastLogin ? new Date(member.lastLogin).toLocaleString("en-KE") : "Never"}</td>
          <td><span className={`product-status ${member.isActive ? "" : "status-low"}`}><i /> {member.isActive ? "ACTIVE" : "INACTIVE"}</span></td>
          <td>{isAdmin && member.id !== user.id && <button className={`small-action ${member.isActive ? "reject-action" : ""}`} onClick={() => setStatus.mutate({ id: member.id, isActive: !member.isActive })} disabled={setStatus.isPending}>{member.isActive ? "Deactivate" : "Activate"}</button>}</td>
        </tr>)}
      </tbody></table>{!staff.data?.length && <EmptyState title="No team members found" detail="Create staff accounts for this branch or refine your search." />}</div>}
    </section>
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
  const [actualCash, setActualCash] = useState("");
  const [movement, setMovement] = useState({ type: "deposit", amount: "", description: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useQuery({ queryKey: ["active-shift"], queryFn: async () => (await api.get<{ shift: { id: number; openingCash: string; openedAt: string } | null }>("/shifts/active")).data.shift });
  const refresh = () => { void query.invalidateQueries({ queryKey: ["active-shift"] }); void query.invalidateQueries({ queryKey: ["dashboard"] }); };
  const open = useMutation({ mutationFn: () => api.post("/shifts/open", { openingCash }), onSuccess: () => { setError(""); setNotice(""); refresh(); }, onError: (reason) => setError(getErrorMessage(reason)) });
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
        {canOperate && <form className="inline-form" onSubmit={(event) => { event.preventDefault(); close.mutate(); }}><label>Actual cash in drawer<input required inputMode="decimal" value={actualCash} onChange={(event) => setActualCash(event.target.value)} placeholder="Count drawer and enter amount" /></label><button className="button button-dark" disabled={close.isPending}>{close.isPending ? "Reconciling…" : "Reconcile & close shift"}</button></form>}
      </div> : canOperate && <form className="operation-form" onSubmit={(event) => { event.preventDefault(); open.mutate(); }}><label>Opening float (KES)<input required inputMode="decimal" value={openingCash} onChange={(event) => setOpeningCash(event.target.value)} /></label><button className="button button-dark" disabled={open.isPending}>{open.isPending ? "Opening…" : "Open cashier shift"}</button></form>}
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
}: {
  receipt: SaleReceipt;
  width: "58mm" | "80mm";
  onWidthChange: (width: "58mm" | "80mm") => void;
  onClose: () => void;
  onNewSale?: () => void;
}) {
  const printReceipt = () => window.print();
  return <div className="receipt-backdrop">
    <section className={`receipt-dialog receipt-${width === "58mm" ? "58" : "80"}`} role="dialog" aria-modal="true" aria-label="Sale receipt">
      <div className="receipt-toolbar no-print">
        <label>Paper size<select value={width} onChange={(event) => onWidthChange(event.target.value as "58mm" | "80mm")}><option value="58mm">58 mm</option><option value="80mm">80 mm</option></select></label>
        <button onClick={printReceipt}><Printer size={16} /> Print</button>
        <button onClick={printReceipt}><Download size={16} /> Save as PDF</button>
        <button className="receipt-close" onClick={onClose}>Close</button>
      </div>
      <article className={`receipt-paper paper-${width === "58mm" ? "58" : "80"}`}>
        <header className="receipt-brand"><span className="brand-mark">s</span><strong>Smart POS</strong><small>{receipt.sale.branch}</small></header>
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
          <div><span>Amount received</span><strong>{money(receipt.sale.cashReceived ?? receipt.sale.total)}</strong></div>
          {Number(receipt.sale.changeDue) > 0 && <div><span>Change</span><strong>{money(receipt.sale.changeDue)}</strong></div>}
        </div>
        <footer className="receipt-thanks">Thank you for shopping with us!</footer>
      </article>
      {onNewSale && <div className="receipt-new-sale no-print"><button className="button button-dark" onClick={onNewSale}>New Sale</button></div>}
    </section>
  </div>;
}

function SalesPage({ user }: { user: User }) {
  const query = useQueryClient();
  const canRefund = user.roles.some((role) => ["admin", "manager"].includes(role));
  const canVerifyBankTransfer = user.roles.includes("admin");
  const [selected, setSelected] = useState<number | null>(null);
  const [receiptSelected, setReceiptSelected] = useState<number | null>(null);
  const [receiptWidth, setReceiptWidth] = useState<"58mm" | "80mm">("80mm");
  const [searchText, setSearchText] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const sales = useQuery({ queryKey: ["sales", searchText, fromDate, toDate], queryFn: async () => (await api.get<{ sales: Array<{
    id: number; receiptNumber: string; total: string; status: string; createdAt: string;
    cashier: string; customer: string | null; itemCount: number;
  }> }>("/sales", { params: { q: searchText, from: fromDate, to: toDate } })).data.sales });
  const refunds = useQuery({ queryKey: ["refunds"], queryFn: async () => (await api.get<{ refunds: Array<{
    id: number; refundNumber: string; receiptNumber: string; reason: string; total: string;
    createdAt: string; createdBy: string;
  }> }>("/refunds")).data.refunds });
  const detail = useQuery({ queryKey: ["sale", selected], enabled: selected !== null, queryFn: async () => (await api.get<{
    sale: { id: number; receiptNumber: string; total: string; status: string };
    items: Array<{ id: number; productId: number; sku: string; name: string; quantity: string; refunded: string; lineTotal: string }>;
  }>(`/sales/${selected}`)).data });
  const receiptQuery = useQuery({
    queryKey: ["sale-receipt", receiptSelected],
    enabled: receiptSelected !== null,
    queryFn: async () => (await api.get<SaleReceipt>(`/sales/${receiptSelected}`)).data,
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
    mutationFn: () => api.post(`/sales/${selected}/refunds`, {
      reason,
      items: Object.entries(quantities).filter(([, quantity]) => Number(quantity) > 0)
        .map(([saleItemId, quantity]) => ({ saleItemId: Number(saleItemId), quantity })),
    }),
    onSuccess: () => {
      setError("");
      setSelected(null);
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
  return <section className="page-content operations-page"><PageHeader eyebrow="TRANSACTION HISTORY" title="Sales & returns" detail="Review recent receipts and process authorized cash refunds." />
    {error && <ErrorBanner message={error} onRetry={() => setError("")} />}
    {sales.isError && <ErrorBanner message={getErrorMessage(sales.error)} onRetry={() => void sales.refetch()} />}
    {refunds.isError && <ErrorBanner message={getErrorMessage(refunds.error)} onRetry={() => void refunds.refetch()} />}
    {selected !== null && <section className="panel operation-form-panel"><div className="panel-heading"><div><div className="eyebrow">RETURN ITEMS</div><h2>Receipt {detail.data?.sale.receiptNumber ?? "…"}</h2></div><button className="small-action reject-action" onClick={() => { setSelected(null); setQuantities({}); }}>Cancel</button></div>
      {detail.isError && <ErrorBanner message={getErrorMessage(detail.error)} onRetry={() => void detail.refetch()} />}
      {detail.isPending ? <LoadingRows /> : detail.data && <form className="return-form" onSubmit={(event) => { event.preventDefault(); setError(""); refund.mutate(); }}>
        <p>Enter the quantity to return for each item. Refund is paid in cash and stock is restored after approval.</p>
        {detail.data.items.map((item) => {
          const remaining = Number(item.quantity) - Number(item.refunded);
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
    <section className="panel operation-table-panel"><div className="panel-heading"><div><div className="eyebrow">BRANCH RECEIPTS</div><h2>Recent sales</h2></div></div>
      <div className="sales-search-bar"><label>Search receipts, transaction ID or cashier<input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Receipt number, ID, cashier" /></label><label>From<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label><label>To<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label></div>
      <div className="product-table-wrap"><table className="product-table"><thead><tr><th>RECEIPT</th><th>DATE</th><th>CASHIER</th><th>CUSTOMER</th><th>ITEMS</th><th>TOTAL</th><th>ACTION</th></tr></thead><tbody>{sales.data?.map((sale) => <tr key={sale.id}><td className="sku-cell">{sale.receiptNumber}</td><td>{new Date(sale.createdAt).toLocaleString("en-KE")}</td><td>{sale.cashier}</td><td>{sale.customer ?? "Walk-in"}</td><td>{sale.itemCount}</td><td className="price-cell">{money(sale.total)}</td><td className="row-actions"><button className="small-action" onClick={() => { setReceiptSelected(sale.id); setError(""); }}>View / Reprint</button>{canRefund && sale.status === "completed" && <button className="small-action" onClick={() => { setSelected(sale.id); setError(""); }}>Return</button>}</td></tr>)}</tbody></table>{!sales.isPending && !sales.data?.length && <EmptyState title="No sales found" detail="Adjust the search or date range, or complete a checkout sale." />}</div>
    </section>
    <section className="panel operation-table-panel"><div className="panel-heading"><div><div className="eyebrow">CASH REFUNDS</div><h2>Recent returns</h2></div></div>
      <div className="product-table-wrap"><table className="product-table"><thead><tr><th>REFUND</th><th>RECEIPT</th><th>REASON</th><th>PROCESSED BY</th><th>DATE</th><th>AMOUNT</th></tr></thead><tbody>{refunds.data?.map((refund) => <tr key={refund.id}><td className="sku-cell">{refund.refundNumber}</td><td>{refund.receiptNumber}</td><td>{refund.reason}</td><td>{refund.createdBy}</td><td>{new Date(refund.createdAt).toLocaleString("en-KE")}</td><td className="price-cell">{money(refund.total)}</td></tr>)}</tbody></table>{!refunds.isPending && !refunds.data?.length && <EmptyState title="No returns recorded" detail="Processed cash refunds will appear here." />}</div>
    </section>
    {receiptSelected !== null && receiptQuery.data && <ReceiptDialog receipt={receiptQuery.data} width={receiptWidth} onWidthChange={setReceiptWidth} onClose={() => setReceiptSelected(null)} />}
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

function PageHeader({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> {eyebrow}</div><h1>{title}<span className="heading-period">.</span></h1><p>{detail}</p></div></div>;
}

function MetricCard({ label, value, caption, icon, tone, loading }: { label: string; value: string; caption: string; icon: ReactNode; tone?: string; loading: boolean }) {
  return <div className={`metric-card ${tone ?? ""}`}><div className="metric-top"><span>{label}</span><div className="metric-icon">{icon}</div></div><div className={`metric-value ${loading ? "skeleton" : ""}`}>{loading ? " " : value}</div><div className="metric-caption">{caption}</div></div>;
}

function PosEntryPage({ user }: { user: User }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [authenticated, setAuthenticated] = useState(false);
  const [cashier, setCashier] = useState<{ id: number; name: string; username: string } | null>(null);
  const session = useQuery({
    queryKey: ["pos-session"],
    queryFn: async () => (await api.get<{ cashier: { id: number; name: string; username: string } }>("/pos/session")).data.cashier,
    retry: false,
  });
  useEffect(() => {
    if (session.data) {
      setCashier(session.data);
      setAuthenticated(true);
    }
  }, [session.data]);
  const login = useMutation({
    mutationFn: () => api.post<{ cashier: { id: number; name: string; username: string } }>("/pos/login", { username, password }),
    onSuccess: ({ data }) => {
      setCashier(data.cashier);
      setAuthenticated(true);
      setMessage("");
    },
    onError: (error) => setMessage(getErrorMessage(error)),
  });
  const logout = useMutation({
    mutationFn: () => api.post("/pos/logout"),
    onSuccess: () => {
      setAuthenticated(false);
      setCashier(null);
      setUsername("");
      setPassword("");
      setMessage("");
      window.location.assign("/");
    },
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const errors: { username?: string; password?: string } = {};
    if (!username) errors.username = "POS username is required.";
    else if (username.trim().length < 4) errors.username = "Username must contain at least 4 characters.";
    if (!password) errors.password = "POS password is required.";
    else if (password.length < 4) errors.password = "Password must contain at least 4 characters.";
    setFieldErrors(errors);
    if (Object.keys(errors).length === 0) login.mutate();
  };
  if (authenticated && cashier) {
    return <PosPage user={user} cashier={cashier} onLogout={() => logout.mutate()} />;
  }
  return (
    <main className="pos-login-page">
      <section className="pos-login-card">
        <div className="pos-login-brand"><span className="brand-mark">s</span><div><strong>Smart POS</strong><small>Cashier authentication</small></div></div>
        <h1>POS access</h1>
        <p>Sign in with an authorized cashier account to open the register.</p>
        {message && <div className="pos-login-error" role="alert">{message}</div>}
        <form onSubmit={submit} noValidate>
          <label><span>POS username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus placeholder="Enter POS username" /><small>{fieldErrors.username}</small></label>
          <label><span>Password</span><div className="pos-password-field"><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="Enter password" /><button type="button" onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? "Hide" : "Show"}</button></div><small>{fieldErrors.password}</small></label>
          <button className="pos-login-submit" disabled={login.isPending}>{login.isPending ? "Authenticating…" : "Open POS register"}</button>
        </form>
        <Link className="pos-login-back" to="/">← Back to main application</Link>
      </section>
    </main>
  );
}

function PosPage({ user, cashier, onLogout }: { user: User; cashier: { id: number; name: string; username: string }; onLogout: () => void }) {
  const queryClient = useQueryClient();
  const canSell = user.roles.some((role) => ["admin", "manager", "cashier"].includes(role));
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<PosCartLine[]>([]);
  const [saleDiscount, setSaleDiscount] = useState("0.00");
  const [toast, setToast] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [openingCash, setOpeningCash] = useState("0.00");
  const [amountPaid, setAmountPaid] = useState("");
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const [receiptWidth, setReceiptWidth] = useState<"58mm" | "80mm">("80mm");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank_transfer">("cash");
  const [bankReference, setBankReference] = useState("");
  const [bankVerification, setBankVerification] = useState<{
    id: number; amount: string; status: "pending" | "verified" | "rejected" | "used";
  } | null>(null);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [shiftCloseOpen, setShiftCloseOpen] = useState(false);
  const [actualCashCounted, setActualCashCounted] = useState("");
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const [closeShiftConfirmOpen, setCloseShiftConfirmOpen] = useState(false);
  const scannerRef = useRef<HTMLInputElement>(null);
  const saleTableRef = useRef<HTMLDivElement>(null);
  const lineIdRef = useRef(0);
  const isAddingProductRef = useRef(false);
  const idempotencyRef = useRef<string | null>(null);
  useEffect(() => {
    window.requestAnimationFrame(() => scannerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!cart.length) return;
    if (saleTableRef.current) saleTableRef.current.scrollTop = saleTableRef.current.scrollHeight;
    scannerRef.current?.focus({ preventScroll: true });
  }, [cart.length]);
  const activeShift = useQuery({
    queryKey: ["active-shift"],
    queryFn: async () => (await api.get<{ shift: { id: number; openingCash: string; openedAt: string; branchName: string } | null }>("/shifts/active")).data.shift,
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
    mutationFn: async () => (await api.post<{ id: number; openingCash: string }>("/shifts/open", { openingCash })).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["active-shift"] }),
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });
  const productsQuery = useQuery({
    queryKey: ["products", search],
    queryFn: async () => (await api.get<{ products: Product[] }>("/products", { params: { search } })).data.products,
  });
  const requestBankVerification = useMutation({
    mutationFn: async () => (await api.post<{ verification: BankTransferVerification }>("/bank-transfer-verifications", {
      reference: bankReference.trim(),
      amount: fromCents(payableCents),
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
      if (!idempotencyRef.current) idempotencyRef.current = crypto.randomUUID();
      const body = {
        items: aggregateCartItems(cart),
        discount: fromCents(discountAmountCents),
        cashReceived: paymentMethod === "cash" ? amountPaid : fromCents(payableCents),
        payments: [{
          method: paymentMethod,
          amount: fromCents(payableCents),
          ...(paymentMethod === "bank_transfer" ? { providerReference: bankReference.trim() } : {}),
        }],
      };
      return (await api.post<{ sale: { id: number; receiptNumber: string; total: string; status: string } }>("/sales", body, {
        headers: { "Idempotency-Key": idempotencyRef.current },
      })).data.sale;
    },
    onSuccess: async (sale) => {
      setToast(`Sale ${sale.receiptNumber} completed · ${money(sale.total)}`);
      setCart([]);
      setSaleDiscount("0.00");
      setAmountPaid("");
      setPaymentMethod("cash");
      setBankReference("");
      setBankVerification(null);
      setCheckoutError("");
      idempotencyRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["sales"] });
      try {
        const { data } = await api.get<SaleReceipt>(`/sales/${sale.id}`);
        setReceipt(data);
      } catch (error) {
        setCheckoutError(`Sale ${sale.receiptNumber} completed, but its receipt could not be loaded: ${getErrorMessage(error)}`);
      }
    },
    onError: (error) => setCheckoutError(getErrorMessage(error)),
  });
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
    const lineId = ++lineIdRef.current;
    setCart((current) => [...current, { lineId, product, quantity: 1 }]);
    return true;
  };
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
      const { data } = await api.get<{ products: Product[] }>("/products", { params: { search: code } });
      const exact = data.products.find((product) => product.barcode === code || product.sku === code);
      const match = exact ?? data.products[selectedSearchIndex] ?? data.products[0];
      if (match) {
        if (addProduct(match)) {
          setSearch("");
          setSelectedSearchIndex(0);
        }
      } else {
        setCheckoutError(`No product found for “${code}”.`);
        setSearch("");
      }
    } catch (error) {
      setCheckoutError(getErrorMessage(error));
    } finally {
      window.requestAnimationFrame(() => {
        scannerRef.current?.focus({ preventScroll: true });
        isAddingProductRef.current = false;
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
  const balanceCents = Math.max(0, payableCents - amountPaidCents);
  const changeCents = Math.max(0, amountPaidCents - payableCents);
  const bankTransferApprovedForTotal = bankVerification?.status === "verified"
    && bankVerification.amount === fromCents(payableCents);
  const canCompletePayment = paymentMethod === "cash"
    ? Boolean(amountPaid.trim()) && amountPaidCents >= payableCents
    : Boolean(bankReference.trim()) && bankTransferApprovedForTotal;
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
      if (event.key === "F5") { event.preventDefault(); setCart([]); setSaleDiscount("0.00"); setAmountPaid(""); setCheckoutError(""); }
      if (event.key === "F6") { event.preventDefault(); if (cart.length) holdSaleMutation.mutate(); }
      if (event.key === "F7") { event.preventDefault(); void heldSalesQuery.refetch(); }
      if (event.key === "F9") {
        event.preventDefault();
        if (canSell && cart.length && canCompletePayment && activeShift.data && !checkout.isPending) checkout.mutate();
      }
      if (event.key === "Escape") { event.preventDefault(); setCart([]); setSaleDiscount("0.00"); setAmountPaid(""); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [cart.length, canSell, canCompletePayment, activeShift.data, checkout.isPending, holdSaleMutation, heldSalesQuery]);

  const actualCashNumber = Math.round((Number(actualCashCounted) || 0) * 100);
  const expectedCashNumber = Math.round(Number(shiftSummary.data?.expectedCash ?? 0) * 100);
  const cashDifferenceNumber = actualCashNumber - expectedCashNumber;

  if (shiftCloseOpen) {
    return (
      <section className="pos-close-screen">
        <header className="pos-dedicated-header">
          <div className="pos-header-brand"><strong>Smart POS</strong><span>{activeShift.data?.branchName ?? `Branch ${user.branchId}`}</span></div>
          <div className="pos-header-cashier"><span>Cashier</span><strong>{cashier.username}</strong></div>
          <button className="pos-header-action" onClick={() => setShiftCloseOpen(false)}>Back to POS</button>
        </header>
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
        <div className="pos-header-cashier"><span>Cashier</span><strong>{cashier.username}</strong></div>
        <div className="pos-header-time"><span>{new Date().toLocaleDateString("en-KE", { weekday: "short", year: "numeric", month: "short", day: "2-digit" })}</span><strong>{new Date().toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}</strong></div>
        <div className="pos-header-shift"><span>Shift</span><strong className={activeShift.data ? "open" : "closed"}>{activeShift.data ? "OPEN" : "CLOSED"}</strong></div>
        <button className="pos-header-action" onClick={() => setShiftCloseOpen(true)}>Shift Change</button>
        <button className="pos-header-signout" onClick={() => setSignOutConfirmOpen(true)}>Sign Out</button>
      </header>
      {signOutConfirmOpen && (
        <div className="pos-confirm-screen" role="dialog" aria-modal="true">
          <section className="pos-confirm-card">
            <span className="pos-confirm-eyebrow">POS SESSION</span>
            <h2>Sign out of POS?</h2>
            {cart.length > 0
              ? <p>Your unfinished sale has {cart.reduce((sum, item) => sum + item.quantity, 0)} item(s). It will be cleared when you sign out.</p>
              : <p>This will end your dedicated POS session and return you to the main dashboard.</p>}
            <div className="pos-confirm-actions">
              <button className="confirm" onClick={() => onLogout()}>Confirm sign out</button>
              <button className="cancel" onClick={() => setSignOutConfirmOpen(false)}>Continue POS</button>
            </div>
          </section>
        </div>
      )}
      {toast && <div role="status" className="success-banner"><ShieldCheck size={17} /> {toast}<button onClick={() => setToast("")} aria-label="Dismiss"><X size={15} /></button></div>}
      {checkoutError && <ErrorBanner message={checkoutError} onRetry={() => setCheckoutError("")} />}
      {activeShift.isError && <ErrorBanner message={getErrorMessage(activeShift.error)} onRetry={() => void activeShift.refetch()} />}
      <div className="pos-layout">
        <div className="pos-catalog">
          {productsQuery.isError && <ErrorBanner message={getErrorMessage(productsQuery.error)} onRetry={() => void productsQuery.refetch()} />}
          <div className="pos-sale-table-wrap" ref={saleTableRef}>
            <table className="pos-sale-table">
              <thead><tr><th>No.</th><th>Product code</th><th>Product name</th><th>Qty</th><th>Unit price</th><th>Total</th><th>Action</th></tr></thead>
              <tbody>
                {cart.map(({ lineId, product, quantity }, index) => <tr className="pos-product-row" key={lineId}>
                  <td>{index + 1}</td><td className="pos-product-code">{product.sku}</td><td className="pos-product-name">{product.name}</td>
                  <td><div className="pos-table-qty"><button onClick={() => adjust(lineId, -1)}>−</button><input value={quantity} onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) setLineQuantity(lineId, next);
                  }} /><button onClick={() => adjust(lineId, 1)}>+</button></div></td>
                  <td>{money(product.sellingPrice)}</td>
                  <td>{money(lineTotalCents({ lineId, product, quantity }) / 100)}</td>
                  <td><button className="pos-row-remove" onClick={() => setCart((current) => current.filter((item) => item.lineId !== lineId))}><X size={14} /></button></td>
                </tr>)}
                <tr className="pos-search-row">
                  <td className="pos-search-cell" colSpan={7}>
                    <input
                      ref={scannerRef}
                      className="pos-search-input"
                      aria-label={`Product entry row ${cart.length + 1}; scan barcode or search products`}
                      autoComplete="off"
                      autoFocus
                      spellCheck={false}
                      value={search}
                      onKeyDown={scan}
                      onChange={(event) => { setSearch(event.target.value); setSelectedSearchIndex(0); }}
                    />
                    {search.trim() && <div className="pos-search-results">
                      {(productsQuery.data ?? []).slice(0, 8).map((product, index) => <button key={product.id} className={index === selectedSearchIndex ? "selected" : ""} onMouseEnter={() => setSelectedSearchIndex(index)} onClick={() => {
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
            <button onClick={() => { setCart([]); setSaleDiscount("0.00"); setAmountPaid(""); setCheckoutError(""); }}><Trash2 size={17} /> Clear <small>(F5)</small></button>
            <button onClick={() => { if (cart.length) holdSaleMutation.mutate(); }} disabled={!cart.length || holdSaleMutation.isPending}><Pause size={17} /> Hold sale <small>(F6)</small></button>
            <button onClick={() => void heldSalesQuery.refetch()}><Printer size={17} /> Retrieve <small>(F7)</small></button>
            <button disabled><Boxes size={17} /> Open drawer <small>(F8)</small></button>
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
            <div className="pos-discount-summary"><label htmlFor="sale-discount">Discount</label><input id="sale-discount" type="number" min="0" max={subtotalCents / 100} step="0.01" value={saleDiscount} onChange={(event) => setSaleDiscount(event.target.value)} onBlur={() => setSaleDiscount(fromCents(discountAmountCents))} inputMode="decimal" /></div>
            <div><span>VAT</span><strong>{money(taxCents / 100)}</strong></div>
            <div className="payable"><span>Total payable</span><strong>{money(payableCents / 100)}</strong></div>
          </div>
          {paymentMethod === "cash" ? <>
            <label className="pos-payment-input"><span>Amount received</span><input value={amountPaid} onChange={(event) => setAmountPaid(event.target.value)} inputMode="decimal" placeholder="0.00" /></label>
            <div className="pos-payment-change"><span>{changeCents > 0 ? "Change due" : "Balance"}</span><strong>{money((changeCents > 0 ? changeCents : balanceCents) / 100)}</strong></div>
          </> : <>
            <label className="pos-payment-input"><span>Bank transaction reference</span><input value={bankReference} onChange={(event) => { setBankReference(event.target.value); setBankVerification(null); }} maxLength={100} autoComplete="off" placeholder="Enter bank transfer reference" /></label>
            <div className="bank-verification-actions">
              <button type="button" disabled={!cart.length || !activeShift.data || !bankReference.trim() || requestBankVerification.isPending || bankVerification?.status === "pending" || bankVerification?.status === "verified"} onClick={() => requestBankVerification.mutate()}>
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
              {bankVerification.status === "verified" && bankVerification.amount !== fromCents(payableCents) && " Sale total changed; request verification for the exact total using a new reference."}
            </div>}
          </>}
          <div className="pos-payment-methods">
            <button className={paymentMethod === "cash" ? "active" : ""} type="button" onClick={() => setPaymentMethod("cash")}>Cash</button>
            <button type="button" disabled title="Configure and verify a payment provider before enabling">M-Pesa</button>
            <button type="button" disabled title="Configure and verify a payment provider before enabling">Card</button>
            <button className={paymentMethod === "bank_transfer" ? "active" : ""} type="button" onClick={() => setPaymentMethod("bank_transfer")}>Bank transfer</button>
            <button type="button" disabled title="Split payment requires verified non-cash providers">Split</button>
          </div>
          <div className="payment-setup-note">{paymentMethod === "bank_transfer" ? "An administrator must independently verify the transfer before completing the sale." : "M-Pesa, card, and split checkout remain disabled until provider integrations are configured."}</div>
          <div className="pos-payment-actions">
            <button className="complete" disabled={!canSell || !cart.length || !canCompletePayment || checkout.isPending || !activeShift.data} onClick={() => checkout.mutate()}>{checkout.isPending ? "Processing…" : "Complete Sale"} <span>F9</span></button>
            <button className="hold" disabled={!cart.length || holdSaleMutation.isPending} onClick={() => holdSaleMutation.mutate()}>Hold Sale <span>F6</span></button>
            <button className="cancel" onClick={() => { setCart([]); setSaleDiscount("0.00"); setAmountPaid(""); }}>Cancel Sale <span>Esc</span></button>
          </div>
          {!canSell ? <div className="checkout-footnote">Your role cannot complete sales.</div>
            : activeShift.isError ? <div className="checkout-footnote">Shift availability could not be checked.</div>
              : activeShift.isPending ? <div className="checkout-footnote">Checking cashier shift…</div>
                : activeShift.data ? <div className="checkout-footnote"><ShieldCheck size={14} /> Stock is updated atomically</div>
                  : <div className="shift-needed"><span>Start a cashier shift.</span><label>Opening cash<input value={openingCash} inputMode="decimal" onChange={(event) => setOpeningCash(event.target.value)} /></label><button className="shift-open-button" onClick={() => openShiftMutation.mutate()}>{openShiftMutation.isPending ? "Opening…" : "Open shift"}</button></div>}
        </aside>
      </div>
      <footer className="pos-statusbar"><span><i /> Ready for new sale...</span><time>{new Date().toLocaleString("en-KE")}</time><b>● Connected</b></footer>
      {receipt && <ReceiptDialog
        receipt={receipt}
        width={receiptWidth}
        onWidthChange={setReceiptWidth}
        onClose={() => setReceipt(null)}
        onNewSale={() => {
          setReceipt(null);
          setCart([]);
          setSaleDiscount("0.00");
          setAmountPaid("");
          setCheckoutError("");
          window.requestAnimationFrame(() => scannerRef.current?.focus());
        }}
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
