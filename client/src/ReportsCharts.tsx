import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import type { BranchReport } from "./api";

const money = (value: number) => new Intl.NumberFormat("en-KE", {
  style: "currency", currency: "KES", maximumFractionDigits: 2,
}).format(value);

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><strong>{title}</strong><span>{detail}</span></div>;
}

export default function ReportsCharts({ report, from, to }: { report: BranchReport; from: string; to: string }) {
  const salesTrend = report.salesTrend.map((point) => ({
    ...point,
    revenue: Number(point.revenue),
    label: new Date(`${point.date}T00:00:00`).toLocaleDateString("en-KE", { day: "numeric", month: "short" }),
  }));
  const payments = report.payments.map((payment) => ({ ...payment, amount: Number(payment.amount) }));
  const categories = report.salesByCategory.map((category) => ({ ...category, revenue: Number(category.revenue) }));
  const paymentColors = ["#4c8056", "#9eb99d", "#d2a06f", "#71818a", "#c5cfbf"];

  return <>
    <div className="report-chart-grid">
      <section className="panel report-panel report-trend-panel">
        <div className="panel-heading"><div><div className="eyebrow">SALES OVER TIME</div><h2>Daily revenue</h2></div><span className="report-range">{from} — {to}</span></div>
        {salesTrend.length ? <div className="report-chart"><ResponsiveContainer width="100%" height="100%">
          <BarChart data={salesTrend} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="#edf0eb" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "#879188", fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(value: number) => `${Math.round(value / 1000)}k`} tick={{ fill: "#879188", fontSize: 10 }} axisLine={false} tickLine={false} width={38} />
            <Tooltip formatter={(value) => money(Number(value ?? 0))} />
            <Bar dataKey="revenue" name="Revenue" fill="#5b8b61" radius={[4, 4, 0, 0]} maxBarSize={38} />
          </BarChart>
        </ResponsiveContainer></div> : <EmptyState title="No completed sales in this period" detail="Daily revenue will appear when sales are recorded." />}
      </section>
      <section className="panel report-panel">
        <div className="panel-heading"><div><div className="eyebrow">TENDER MIX</div><h2>Payment methods</h2></div></div>
        {payments.length ? <div className="report-pie-wrap">
          <div className="report-pie"><ResponsiveContainer width="100%" height="100%">
            <PieChart><Pie data={payments} dataKey="amount" nameKey="method" innerRadius={56} outerRadius={84} paddingAngle={3}>
              {payments.map((payment, index) => <Cell key={payment.method} fill={paymentColors[index % paymentColors.length]} />)}
            </Pie><Tooltip formatter={(value) => money(Number(value ?? 0))} /><Legend /></PieChart>
          </ResponsiveContainer></div>
        </div> : <EmptyState title="No payments in this period" detail="Payment mix appears after completed sales." />}
      </section>
    </div>
    <div className="report-chart-grid">
      <section className="panel report-panel">
        <div className="panel-heading"><div><div className="eyebrow">PRODUCT MIX</div><h2>Sales by category</h2></div></div>
        {categories.length ? <div className="report-chart report-category-chart"><ResponsiveContainer width="100%" height="100%">
          <BarChart data={categories} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="#edf0eb" horizontal={false} />
            <XAxis type="number" tickFormatter={(value: number) => `${Math.round(value / 1000)}k`} tick={{ fill: "#879188", fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" width={95} tick={{ fill: "#68746a", fontSize: 9 }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(value) => money(Number(value ?? 0))} />
            <Bar dataKey="revenue" name="Revenue" fill="#789877" radius={[0, 4, 4, 0]} maxBarSize={20} />
          </BarChart>
        </ResponsiveContainer></div> : <EmptyState title="No category sales" detail="Category breakdown appears when sales are recorded." />}
      </section>
    </div>
  </>;
}
