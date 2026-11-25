import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CircleDollarSign, Clock3, Radio, Users } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, getErrorMessage, type User } from "./api";

type PaymentTotals = Record<"cash" | "mpesa" | "card" | "bank_transfer" | "credit", string>;
type Cashier = {
  id: number;
  name: string;
  username: string | null;
  employeeNumber: string | null;
  branchId: number;
  branch: string;
  roles: string[];
  online: boolean;
  active: boolean;
  loginAt: string | null;
  lastActivityAt: string | null;
  shiftId: number | null;
  shiftStatus: "open" | "closed" | null;
  shiftOpenedAt: string | null;
  shiftClosedAt: string | null;
  counter: string | null;
  openingCash: string;
  status: "active" | "idle" | "shift_open_offline" | "offline" | "shift_closed";
  transactions: number;
  grossSales: string;
  discounts: string;
  refunds: string;
  netSales: string;
  payments: PaymentTotals;
  expenses: string;
  expectedCash: string;
  shiftDurationSeconds: number;
};
type MonitorResponse = {
  cashiers: Cashier[];
  updatedAt: string;
  totals: {
    online: number;
    activeShifts: number;
    transactions: number;
    grossSales: string;
    refunds: string;
    netSales: string;
    payments: PaymentTotals;
  };
  thresholds: { onlineSeconds: number; idleSeconds: number };
};
type MonitorDetails = {
  cashier: Cashier;
  transactions: Array<{
    id: number; receiptNumber: string; total: string; discount: string; status: string;
    createdAt: string | null; customer: string | null; itemCount: number; quantity: string;
    paymentMethod: string | null; refunded: string;
  }>;
  expenses: Array<{
    id: number; category: string; description: string; amount: string;
    paymentMethod: string; status: string; createdAt: string | null;
  }>;
  cashMovements: Array<{
    id: number; type: string; amount: string; description: string; createdAt: string | null;
  }>;
};
type MonitoredReceipt = {
  sale: {
    id: number; receiptNumber: string; subtotal: string; discount: string; tax: string;
    total: string; status: string; createdAt: string | null; cashier: string;
    customer: string | null; branch: string; cashReceived: string | null; changeDue: string;
  };
  items: Array<{
    id: number; sku: string; name: string; quantity: string; unitPrice: string;
    lineTotal: string; refunded: string;
  }>;
  payments: Array<{ method: string; amount: string; status: string; reference: string | null }>;
};

const money = (value: string | number) => new Intl.NumberFormat("en-KE", {
  style: "currency", currency: "KES", maximumFractionDigits: 2,
}).format(Number(value));
const dateTime = (value: string | null) => value
  ? new Date(value).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })
  : "—";
const duration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
};
const statusLabels: Record<Cashier["status"], string> = {
  active: "Online · Active",
  idle: "Online · Idle",
  shift_open_offline: "Shift Open · Offline",
  offline: "Offline",
  shift_closed: "Shift Closed",
};

function useMonitoring(params: Record<string, string | undefined>, live = false) {
  const queryClient = useQueryClient();
  const [streamConnected, setStreamConnected] = useState(false);
  const parameterKey = JSON.stringify(params);
  const query = useQuery({
    queryKey: ["cashier-monitoring", params],
    queryFn: async () => (await api.get<MonitorResponse>("/cashier-monitoring", { params })).data,
    refetchInterval: live && streamConnected ? false : 10_000,
    refetchIntervalInBackground: true,
  });
  useStateEffect(live, parameterKey, params, queryClient, setStreamConnected);
  return query;
}

function useStateEffect(
  live: boolean,
  parameterKey: string,
  params: Record<string, string | undefined>,
  queryClient: ReturnType<typeof useQueryClient>,
  setStreamConnected: (connected: boolean) => void,
): void {
  useEffect(() => {
    if (!live) {
      setStreamConnected(false);
      return;
    }
    const baseUrl = api.defaults.baseURL ?? "/api";
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/cashier-monitoring/live`, window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    const stream = new EventSource(url, { withCredentials: true });
    stream.onopen = () => setStreamConnected(true);
    stream.onmessage = (event) => {
      queryClient.setQueryData(["cashier-monitoring", params], JSON.parse(event.data) as MonitorResponse);
    };
    stream.addEventListener("monitor-error", () => setStreamConnected(false));
    stream.onerror = () => setStreamConnected(false);
    return () => {
      stream.close();
      setStreamConnected(false);
    };
  }, [live, parameterKey, params, queryClient, setStreamConnected]);
}

export function LiveCashierSummary() {
  const monitoring = useMonitoring({ scope: "today" });
  const data = monitoring.data;
  if (monitoring.isError) {
    return <section className="panel cashier-monitor-summary">
      <div className="panel-heading"><div><div className="eyebrow">LIVE OPERATIONS</div><h2>Live Cashiers / Active Cashiers</h2></div></div>
      <p className="cashier-monitor-error">{getErrorMessage(monitoring.error)}</p>
    </section>;
  }
  return <section className="panel cashier-monitor-summary">
    <div className="panel-heading">
      <div><div className="eyebrow">LIVE OPERATIONS</div><h2>Live Cashiers / Active Cashiers</h2></div>
      <Link className="text-link" to="/cashier-monitor">Open monitoring <span aria-hidden="true">→</span></Link>
    </div>
    <div className="cashier-monitor-kpis cashier-monitor-kpis-compact">
      <div><span>Cashiers online</span><strong>{data?.totals.online ?? "—"}</strong></div>
      <div><span>Active shifts</span><strong>{data?.totals.activeShifts ?? "—"}</strong></div>
      <div><span>Gross sales today</span><strong>{data ? money(data.totals.grossSales) : "—"}</strong></div>
      <div><span>Transactions today</span><strong>{data?.totals.transactions ?? "—"}</strong></div>
      <div><span>Cash sales today</span><strong>{data ? money(data.totals.payments.cash) : "—"}</strong></div>
      <div><span>M-PESA sales today</span><strong>{data ? money(data.totals.payments.mpesa) : "—"}</strong></div>
      <div><span>Refunds today</span><strong>{data ? money(data.totals.refunds) : "—"}</strong></div>
      <div><span>Net sales today</span><strong>{data ? money(data.totals.netSales) : "—"}</strong></div>
    </div>
    <div className="cashier-monitor-short-list">
      {(data?.cashiers ?? []).filter((cashier) => cashier.online || cashier.shiftStatus === "open").slice(0, 5).map((cashier) =>
        <div key={cashier.id}>
          <span className={`cashier-presence-dot presence-${cashier.status}`} />
          <strong>{cashier.name}</strong><small>{cashier.counter || "Counter unassigned"} · {statusLabels[cashier.status]}</small>
          <b>{money(cashier.grossSales)}</b>
        </div>)}
      {!monitoring.isPending && !data?.cashiers.some((cashier) => cashier.online || cashier.shiftStatus === "open")
        && <p className="cashier-monitor-empty">No cashiers are online or have an open shift.</p>}
    </div>
  </section>;
}

export default function CashierMonitoringPage({ user }: { user: User }) {
  const isAdmin = user.roles.includes("admin");
  const [scope, setScope] = useState<"shift" | "today" | "custom">("shift");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [branchId, setBranchId] = useState("");
  const [cashierId, setCashierId] = useState("");
  const [counter, setCounter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedCashier, setSelectedCashier] = useState<number | null>(null);
  const [selectedSale, setSelectedSale] = useState<number | null>(null);
  const params = {
    scope, from: scope === "custom" ? from : undefined, to: scope === "custom" ? to : undefined,
    branchId: isAdmin && branchId ? branchId : undefined,
    cashierId: cashierId || undefined, counter: counter || undefined,
  };
  const monitoring = useMonitoring(params, true);
  const branches = useQuery({
    queryKey: ["cashier-monitoring-branches"],
    enabled: isAdmin,
    queryFn: async () => (await api.get<{ branches: Array<{ id: number; name: string; code: string }> }>("/staff/branches")).data.branches,
  });
  const detail = useQuery({
    queryKey: ["cashier-monitor-details", selectedCashier],
    enabled: selectedCashier !== null,
    refetchInterval: 10_000,
    queryFn: async () => (await api.get<MonitorDetails>(`/cashier-monitoring/cashiers/${selectedCashier}`)).data,
  });
  const receipt = useQuery({
    queryKey: ["cashier-monitor-receipt", selectedSale],
    enabled: selectedSale !== null,
    queryFn: async () => (await api.get<MonitoredReceipt>(`/cashier-monitoring/sales/${selectedSale}`)).data,
  });
  const data = monitoring.data;
  const filteredCashiers = (data?.cashiers ?? []).filter((cashier) =>
    !search || `${cashier.name} ${cashier.username ?? ""} ${cashier.employeeNumber ?? ""}`
      .toLowerCase().includes(search.toLowerCase()));
  const counters = [...new Set((data?.cashiers ?? []).map((cashier) => cashier.counter).filter((value): value is string => Boolean(value)))];
  const updatedAt = data?.updatedAt ? new Date(data.updatedAt) : null;
  const stale = updatedAt ? Date.now() - updatedAt.getTime() > 30_000 : true;

  return <section className="page-content operations-page cashier-monitoring-page">
    <div className="page-heading">
      <div><div className="eyebrow"><span className="eyebrow-dot" /> LIVE OPERATIONS</div>
        <h1>Live Cashier Monitoring</h1>
        <p>Presence, shifts, and confirmed sales from the POS ledger.</p></div>
      <div className="cashier-monitor-update" aria-live="polite">
        <span className={stale ? "monitor-connection-stale" : "monitor-connection-live"}><Radio size={15} />{stale ? "Update delayed" : "Live · polling"}</span>
        <small>Last update {updatedAt?.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) ?? "—"}</small>
      </div>
    </div>
    {monitoring.isError && <div role="alert" className="error-banner">{getErrorMessage(monitoring.error)}</div>}
    {branches.isError && <div role="alert" className="error-banner">{getErrorMessage(branches.error)}</div>}
    <div className="cashier-monitor-filters">
      <label>Sales period<select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
        <option value="shift">Current shift</option><option value="today">Today</option><option value="custom">Date range</option>
      </select></label>
      {scope === "custom" && <>
        <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </>}
      {isAdmin && <label>Branch<select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
        <option value="">All branches</option>{branches.data?.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select></label>}
      <label>Cashier<select value={cashierId} onChange={(event) => setCashierId(event.target.value)}>
        <option value="">All cashiers</option>{data?.cashiers.map((cashier) => <option key={cashier.id} value={cashier.id}>{cashier.name}</option>)}
      </select></label>
      <label>Counter<select value={counter} onChange={(event) => setCounter(event.target.value)}>
        <option value="">All counters</option>{counters.map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label className="cashier-monitor-search">Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, username, employee ID" /></label>
    </div>
    {scope === "custom" && (!from || !to || from > to) && <p className="cashier-monitor-hint">Choose a complete, ordered date range to view sales.</p>}
    <div className="cashier-monitor-kpis">
      <div><span><Users size={15} /> Cashiers Online</span><strong>{data?.totals.online ?? "—"}</strong><small>Active or idle POS sessions</small></div>
      <div><span><Clock3 size={15} /> Active Shifts</span><strong>{data?.totals.activeShifts ?? "—"}</strong><small>Open cashier drawers</small></div>
      <div><span><CircleDollarSign size={15} /> Gross Sales</span><strong>{data ? money(data.totals.grossSales) : "—"}</strong><small>Completed transactions only</small></div>
      <div><span><Activity size={15} /> Transactions</span><strong>{data?.totals.transactions ?? "—"}</strong><small>Confirmed sales</small></div>
      <div><span>Cash Sales</span><strong>{data ? money(data.totals.payments.cash) : "—"}</strong><small>Completed cash payments</small></div>
      <div><span>M-PESA Sales</span><strong>{data ? money(data.totals.payments.mpesa) : "—"}</strong><small>Confirmed M-PESA only</small></div>
      <div><span>Refunds</span><strong>{data ? money(data.totals.refunds) : "—"}</strong><small>Completed refunds</small></div>
      <div><span>Net Sales</span><strong>{data ? money(data.totals.netSales) : "—"}</strong><small>Gross less completed refunds</small></div>
    </div>
    <section className="panel operation-table-panel cashier-monitor-table">
      <div className="panel-heading"><div><div className="eyebrow">CASHIER STATUS & PERFORMANCE</div><h2>Live Cashiers / Active Cashiers</h2></div>
        <span className="cashier-monitor-poll"><Radio size={14} /> Refreshes every 10 seconds</span></div>
      {monitoring.isPending ? <div className="loading-rows">Loading cashier activity…</div> : <div className="product-table-wrap">
        <table className="product-table"><thead><tr>
          <th>CASHIER</th><th>BRANCH / COUNTER</th><th>STATUS</th><th>LOGIN / SHIFT</th>
          <th>DURATION</th><th>TRANSACTIONS</th><th>GROSS SALES</th><th>REFUNDS</th><th>NET SALES</th>
        </tr></thead><tbody>
          {filteredCashiers.map((cashier) => <tr key={cashier.id}>
            <td><button className="cashier-monitor-person" onClick={() => { setSelectedCashier(cashier.id); setSelectedSale(null); }}>
              <span className="cashier-initials">{cashier.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
              <span><strong>{cashier.name}</strong><small>{cashier.username ?? "No username"}{cashier.employeeNumber ? ` · ${cashier.employeeNumber}` : ""}</small></span>
            </button></td>
            <td>{cashier.branch}<small className="cashier-cell-subtitle">{cashier.counter || "Counter unassigned"}</small></td>
            <td><span className={`cashier-presence-label presence-${cashier.status}`}><i />{statusLabels[cashier.status]}</span></td>
            <td><span>{dateTime(cashier.loginAt)}</span><small className="cashier-cell-subtitle">{cashier.shiftStatus === "open" ? `Shift opened ${dateTime(cashier.shiftOpenedAt)}` : "No open shift"}</small><small className="cashier-cell-subtitle">Activity {dateTime(cashier.lastActivityAt)}</small></td>
            <td>{duration(cashier.shiftDurationSeconds)}</td><td>{cashier.transactions}</td>
            <td className="price-cell">{money(cashier.grossSales)}</td><td>{money(cashier.refunds)}</td><td className="price-cell">{money(cashier.netSales)}</td>
          </tr>)}
        </tbody></table>
        {!filteredCashiers.length && <div className="cashier-monitor-empty">{monitoring.isError ? "Cashier activity is unavailable." : "No cashiers match the selected filters."}</div>}
      </div>}
    </section>
    {selectedCashier !== null && <div className="cashier-monitor-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) { setSelectedCashier(null); setSelectedSale(null); }
    }}>
      <section className="cashier-monitor-drawer" role="dialog" aria-modal="true" aria-label="Cashier shift details">
        <div className="cashier-monitor-drawer-heading"><div><div className="eyebrow">CASHIER MONITORING</div>
          <h2>{detail.data?.cashier.name ?? "Loading cashier…"}</h2></div>
          <button type="button" className="small-action" onClick={() => { setSelectedCashier(null); setSelectedSale(null); }}>Close</button></div>
        {detail.isError && <div role="alert" className="error-banner">{getErrorMessage(detail.error)}</div>}
        {detail.isPending ? <div className="loading-rows">Loading shift details…</div> : detail.data && <>
          <div className="cashier-detail-identity">
            <div><span>USERNAME / EMPLOYEE ID</span><strong>{detail.data.cashier.username ?? "—"} · {detail.data.cashier.employeeNumber ?? "No employee ID"}</strong></div>
            <div><span>BRANCH / COUNTER</span><strong>{detail.data.cashier.branch} · {detail.data.cashier.counter ?? "Not assigned"}</strong></div>
            <div><span>ROLE / ONLINE STATUS</span><strong>{detail.data.cashier.roles.join(", ") || "Cashier"} · {statusLabels[detail.data.cashier.status]}</strong></div>
            <div><span>SHIFT STATUS / COUNTER</span><strong>{detail.data.cashier.shiftStatus?.toUpperCase() ?? "NO SHIFT"} · {detail.data.cashier.counter ?? "Not assigned"}</strong></div>
            <div><span>LOGIN / SHIFT OPENED</span><strong>{dateTime(detail.data.cashier.loginAt)} / {dateTime(detail.data.cashier.shiftOpenedAt)}</strong></div>
            <div><span>LAST ACTIVITY</span><strong>{dateTime(detail.data.cashier.lastActivityAt)}</strong></div>
          </div>
          <div className="cashier-detail-metrics">
            <div><span>Opening cash</span><strong>{money(detail.data.cashier.openingCash)}</strong></div>
            <div><span>Transactions</span><strong>{detail.data.cashier.transactions}</strong></div>
            <div><span>Gross sales</span><strong>{money(detail.data.cashier.grossSales)}</strong></div>
            <div><span>Discounts</span><strong>{money(detail.data.cashier.discounts)}</strong></div>
            <div><span>Refunds</span><strong>{money(detail.data.cashier.refunds)}</strong></div>
            <div><span>Net sales</span><strong>{money(detail.data.cashier.netSales)}</strong></div>
            <div><span>Expected drawer cash</span><strong>{money(detail.data.cashier.expectedCash)}</strong></div>
            <div><span>Shift duration</span><strong>{duration(detail.data.cashier.shiftDurationSeconds)}</strong></div>
          </div>
          <section className="cashier-detail-section"><h3>Payment breakdown</h3>
            <div className="cashier-payment-breakdown">{(Object.entries(detail.data.cashier.payments) as Array<[keyof PaymentTotals, string]>).map(([method, amount]) =>
              <div key={method}><span>{method.replace("_", " ").toUpperCase()}</span><strong>{money(amount)}</strong></div>)}</div>
          </section>
          <section className="cashier-detail-section"><h3>Sales transaction history</h3>
            <div className="product-table-wrap"><table className="product-table"><thead><tr><th>RECEIPT / TIME</th><th>CUSTOMER</th><th>ITEMS / QTY</th><th>PAYMENT</th><th>DISCOUNT</th><th>TOTAL</th><th>STATUS</th></tr></thead>
              <tbody>{detail.data.transactions.map((transaction) => <tr key={transaction.id}>
                <td><button className="small-action" onClick={() => setSelectedSale(transaction.id)}>{transaction.receiptNumber}<small>{dateTime(transaction.createdAt)}</small></button></td>
                <td>{transaction.customer ?? "Walk-in"}</td><td>{transaction.itemCount} / {transaction.quantity}</td>
                <td>{transaction.paymentMethod?.replaceAll(",", " + ").replaceAll("_", " ") ?? "—"}</td>
                <td>{money(transaction.discount)}</td><td>{money(transaction.total)}</td><td>{transaction.status.replace("_", " ").toUpperCase()}</td>
              </tr>)}</tbody></table>
              {!detail.data.transactions.length && <p className="cashier-monitor-empty">No transactions recorded in this open shift.</p>}
            </div>
          </section>
          <section className="cashier-detail-section"><h3>Shift expenses</h3>
            {detail.data.expenses.length ? detail.data.expenses.map((expense) => <div className="cashier-activity-row" key={expense.id}>
              <span>{expense.category} · {expense.description} · {expense.paymentMethod.replace("_", " ")}</span><strong>{money(expense.amount)}</strong>
            </div>) : <p className="cashier-monitor-empty">No expenses recorded.</p>}
          </section>
          <section className="cashier-detail-section"><h3>Drawer movements</h3>
            {detail.data.cashMovements.length ? detail.data.cashMovements.map((movement) => <div className="cashier-activity-row" key={movement.id}>
              <span>{movement.type.toUpperCase()} · {movement.description}</span><strong>{money(movement.amount)}</strong>
            </div>) : <p className="cashier-monitor-empty">No cash movements recorded.</p>}
          </section>
        </>}
      </section>
    </div>}
    {selectedSale !== null && <div className="cashier-monitor-backdrop cashier-receipt-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setSelectedSale(null);
    }}>
      <section className="cashier-monitor-receipt" role="dialog" aria-modal="true" aria-label="Transaction receipt">
        <div className="cashier-monitor-drawer-heading"><div><div className="eyebrow">TRANSACTION RECEIPT</div><h2>{receipt.data?.sale.receiptNumber ?? "Loading receipt…"}</h2></div>
          <button type="button" className="small-action" onClick={() => setSelectedSale(null)}>Close</button></div>
        {receipt.isError && <div role="alert" className="error-banner">{getErrorMessage(receipt.error)}</div>}
        {receipt.data && <>
          <p>{receipt.data.sale.cashier} · {receipt.data.sale.customer ?? "Walk-in"} · {dateTime(receipt.data.sale.createdAt)}</p>
          <div className="product-table-wrap"><table className="product-table"><thead><tr><th>ITEM</th><th>QUANTITY</th><th>UNIT PRICE</th><th>TOTAL</th></tr></thead><tbody>
            {receipt.data.items.map((item) => <tr key={item.id}><td>{item.name}<small className="cashier-cell-subtitle">{item.sku}{Number(item.refunded) > 0 ? ` · Refunded ${item.refunded}` : ""}</small></td><td>{item.quantity}</td><td>{money(item.unitPrice)}</td><td>{money(item.lineTotal)}</td></tr>)}
          </tbody></table></div>
          <div className="cashier-receipt-totals"><span>Subtotal {money(receipt.data.sale.subtotal)}</span><span>Discount −{money(receipt.data.sale.discount)}</span>
            <strong>Total {money(receipt.data.sale.total)}</strong><span>Status {receipt.data.sale.status.replace("_", " ")}</span></div>
          <div className="cashier-payment-breakdown">{receipt.data.payments.map((payment, index) =>
            <div key={`${payment.method}-${index}`}><span>{payment.method.replace("_", " ").toUpperCase()} · {payment.status.toUpperCase()}</span><strong>{money(payment.amount)}</strong></div>)}</div>
        </>}
      </section>
    </div>}
  </section>;
}
