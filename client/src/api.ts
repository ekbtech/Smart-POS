import axios from "axios";

export const api = axios.create({
  baseURL: "/api",
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

export type User = {
  id: number;
  name: string;
  email: string;
  username?: string;
  roles: string[];
  branchId: number;
  modules?: string[];
  defaultLanding?: string;
  mustChangePassword?: boolean;
};

export type Product = {
  id: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  sellingPrice: string;
  purchasePrice: string | null;
  taxRate: string;
  reorderLevel: string;
  stock: string;
  barcode: string | null;
  hasImage: boolean;
};

export type DashboardSummary = {
  todaySales: string;
  todayTransactions: number;
  productCount: number;
  lowStockCount: number;
  recentSales: Array<{
    id: number;
    receiptNumber: string;
    total: string;
    createdAt: string;
    cashier: string;
    status: string;
  }>;
  lowStockProducts: Array<{ id: number; name: string; stock: string; reorderLevel: string }>;
};

export type BranchReport = {
  range: { from: string; to: string };
  summary: {
    revenue: string;
    tax: string;
    transactions: number;
    averageOrder: string;
    refunds: string;
    netRevenue: string;
    grossProfit: string | null;
    costCoverage: number;
    costedUnits: string;
    soldUnits: string;
    expenses: string;
    pendingExpenses: string;
    netProfit: string | null;
    purchaseSpend: string;
    inventoryValue: string;
    inventoryUnits: string;
  };
  salesTrend: Array<{ date: string; revenue: string; transactions: number }>;
  salesByCashier: Array<{ name: string; transactions: number; revenue: string }>;
  topProducts: Array<{ name: string; sku: string; quantity: string; revenue: string }>;
  salesByCategory: Array<{ name: string; revenue: string }>;
  payments: Array<{ method: string; amount: string; transactions: number }>;
  expensesByCategory: Array<{ category: string; amount: string; count: number }>;
  purchases: Array<{ status: string; count: number; orderedCost: string; receivedCost: string }>;
  lowStock: Array<{ id: number; sku: string; name: string; available: string; reorderLevel: string }>;
};

export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.error ?? error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
