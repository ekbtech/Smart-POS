import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

type SalesPoint = { date: string; revenue: string; transactions: number };

const money = (value: number) => new Intl.NumberFormat("en-KE", {
  style: "currency", currency: "KES", maximumFractionDigits: 2,
}).format(value);

export default function DashboardSalesChart({ salesTrend, todayDate }: { salesTrend: SalesPoint[]; todayDate: string }) {
  const salesByDate = new Map(salesTrend.map((point) => [point.date, point]));
  const today = new Date(`${todayDate}T00:00:00`);
  const data = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - 6 + index);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const point = salesByDate.get(dateKey);
    return {
      date: dateKey,
      revenue: Number(point?.revenue ?? 0),
      transactions: Number(point?.transactions ?? 0),
      label: date.toLocaleDateString("en-KE", { day: "numeric", month: "short" }),
    };
  });

  if (!data.some((point) => point.transactions > 0)) {
    return <div className="dashboard-chart-empty">
      <strong>No sales recorded this week</strong>
      <span>Completed daily sales will appear here.</span>
    </div>;
  }

  return <div className="dashboard-chart" role="img" aria-label="Daily sales revenue for the last seven days">
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="var(--line)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis
          tickFormatter={(value: number) => new Intl.NumberFormat("en-KE", {
            notation: "compact", maximumFractionDigits: 1,
          }).format(value)}
          tick={{ fill: "var(--muted)", fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <Tooltip
          labelFormatter={(label) => String(label)}
          formatter={(value, _name, item) => [
            `${money(Number(value ?? 0))} · ${item.payload.transactions} sales`,
            "Revenue",
          ]}
          contentStyle={{ border: "1px solid var(--line)", borderRadius: 8, boxShadow: "0 8px 24px rgba(24, 48, 32, .12)" }}
        />
        <Bar dataKey="revenue" name="Revenue" fill="var(--green)" radius={[5, 5, 0, 0]} maxBarSize={42} />
      </BarChart>
    </ResponsiveContainer>
  </div>;
}
