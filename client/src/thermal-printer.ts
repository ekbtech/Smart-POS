import { api } from "./api";

export type SaleReceipt = {
  sale: {
    id: number;
    receiptNumber: string;
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    status: string;
    createdAt: string;
    cashier: string;
    customer: string | null;
    branch: string;
    cashReceived: string | null;
    changeDue: string;
  };
  business: { name: string; phone: string; address: string; logoUrl: string | null };
  items: Array<{
    id: number;
    productId?: number;
    sku: string;
    name: string;
    quantity: string;
    refunded?: string;
    unitPrice: string;
    taxRate?: string;
    lineTotal: string;
  }>;
  payments: Array<{ method: string; amount: string; status: string; reference: string | null }>;
};

const thermalPrinterName = /thermal|receipt|pos|80\s?mm/i;
type QzTrayApi = typeof import("qz-tray").default;
let qzApiPromise: Promise<QzTrayApi> | undefined;
let securityConfigured = false;

function configureSecurity(qz: QzTrayApi): void {
  if (securityConfigured) return;
  qz.security.setCertificatePromise((resolve, reject) => {
    void api.get<string>("/pos/printing/qz/certificate", { responseType: "text" })
      .then(({ data }) => resolve(data))
      .catch(reject);
  });
  qz.security.setSignatureAlgorithm("SHA512");
  qz.security.setSignaturePromise((request) => (resolve, reject) => {
    void api.post<{ signature: string }>("/pos/printing/qz/signature", { request })
      .then(({ data }) => resolve(data.signature))
      .catch(reject);
  });
  securityConfigured = true;
}

async function getConnectedQz(): Promise<QzTrayApi> {
  if (typeof window === "undefined") throw new Error("Receipt printing is only available in the cashier browser.");
  if (!qzApiPromise) {
    qzApiPromise = import("qz-tray").then(({ default: qz }) => {
      if (!qz) throw new Error("QZ Tray could not be loaded. Reload the POS and try again.");
      return qz;
    });
  }
  const qz = await qzApiPromise;
  configureSecurity(qz);
  if (!qz.websocket.isActive()) await qz.websocket.connect({ retries: 2, delay: 1 });
  return qz;
}

export async function discoverReceiptPrinters(): Promise<string[]> {
  const qz = await getConnectedQz();
  return qz.printers.find();
}

export function suggestReceiptPrinter(printers: string[]): string {
  return printers.find((printer) => thermalPrinterName.test(printer)) ?? "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

const receiptMoney = (value: string | number) => new Intl.NumberFormat("en-KE", {
  style: "currency",
  currency: "KES",
  maximumFractionDigits: 2,
}).format(Number(value));

export function build80mmReceiptHtml(receipt: SaleReceipt): string {
  const completedPayments = receipt.payments.filter((payment) => payment.status === "completed");
  const amountPaid = completedPayments.reduce((total, payment) => total + Number(payment.amount), 0);
  const change = Number(receipt.sale.changeDue);
  const imageUrl = receipt.business.logoUrl
    && URL.canParse(receipt.business.logoUrl, window.location.origin)
    ? new URL(receipt.business.logoUrl, window.location.origin)
    : null;
  const logo = imageUrl && ["http:", "https:"].includes(imageUrl.protocol)
    ? `<img class="logo" src="${escapeHtml(imageUrl.href)}" alt="">`
    : "";
  const items = receipt.items.map((item) => `
    <tr>
      <td class="item-name">${escapeHtml(item.name)}</td>
      <td class="number">${escapeHtml(Number(item.quantity).toLocaleString("en-KE"))}</td>
      <td class="number">${escapeHtml(receiptMoney(item.lineTotal))}</td>
    </tr>
    <tr class="item-detail"><td colspan="3">${escapeHtml(receiptMoney(item.unitPrice))} each</td></tr>`).join("");
  const payments = completedPayments.map((payment) => `
    <div class="row"><span>${escapeHtml(payment.method.replaceAll("_", " ").toUpperCase())}</span><strong>${escapeHtml(receiptMoney(payment.amount))}</strong></div>`).join("");
  const cashReceived = receipt.sale.cashReceived === null
    ? ""
    : `<div class="row"><span>Cash received</span><strong>${escapeHtml(receiptMoney(receipt.sale.cashReceived))}</strong></div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@page { size: 80mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { width: 80mm; margin: 0; padding: 0; color: #000; background: #fff; }
body { font: 10px Arial, sans-serif; }
main { width: 74mm; margin: 0 auto; padding: 3mm 0 4mm; }
header { text-align: center; padding-bottom: 3mm; border-bottom: 1px dashed #000; }
.logo { display: block; max-width: 24mm; max-height: 16mm; object-fit: contain; margin: 0 auto 2mm; }
h1 { margin: 0 0 1mm; font-size: 15px; }
header p { margin: 1mm 0 0; font-size: 9px; }
.meta { padding: 2.5mm 0; border-bottom: 1px dashed #000; }
.row { display: flex; justify-content: space-between; gap: 2mm; margin: 1mm 0; }
.row span { min-width: 0; }
table { width: 100%; border-collapse: collapse; margin: 2.5mm 0; }
th { padding: 1mm 0; border-bottom: 1px solid #000; text-align: left; }
th.number, td.number { text-align: right; white-space: nowrap; }
.item-name { overflow-wrap: anywhere; }
.item-detail td { padding: 0 0 1.5mm; color: #333; font-size: 8px; }
.totals { padding: 2mm 0; border-top: 1px dashed #000; border-bottom: 1px dashed #000; }
.grand-total { margin-top: 2mm; padding-top: 2mm; border-top: 1px solid #000; font-size: 13px; font-weight: bold; }
.payment { padding: 2mm 0; }
.thanks { margin-top: 2mm; padding-top: 2mm; border-top: 1px dashed #000; text-align: center; font-weight: bold; }
</style></head><body><main>
<header>${logo}<h1>${escapeHtml(receipt.business.name)}</h1>
<p>${escapeHtml(receipt.business.address)}</p><p>${escapeHtml(receipt.business.phone)}</p></header>
<section class="meta">
<div class="row"><span>Receipt</span><strong>${escapeHtml(receipt.sale.receiptNumber)}</strong></div>
<div class="row"><span>Date</span><strong>${escapeHtml(new Date(receipt.sale.createdAt).toLocaleString("en-KE"))}</strong></div>
<div class="row"><span>Cashier</span><strong>${escapeHtml(receipt.sale.cashier)}</strong></div>
${receipt.sale.customer ? `<div class="row"><span>Customer</span><strong>${escapeHtml(receipt.sale.customer)}</strong></div>` : ""}
</section>
<table><thead><tr><th>Item</th><th class="number">Qty</th><th class="number">Total</th></tr></thead><tbody>${items}</tbody></table>
<section class="totals">
<div class="row"><span>Subtotal</span><strong>${escapeHtml(receiptMoney(receipt.sale.subtotal))}</strong></div>
<div class="row"><span>Discount</span><strong>-${escapeHtml(receiptMoney(receipt.sale.discount))}</strong></div>
<div class="row"><span>Tax / VAT</span><strong>${escapeHtml(receiptMoney(receipt.sale.tax))}</strong></div>
<div class="row grand-total"><span>Grand total</span><strong>${escapeHtml(receiptMoney(receipt.sale.total))}</strong></div>
</section>
<section class="payment">${payments}
<div class="row"><span>Amount paid</span><strong>${escapeHtml(receiptMoney(amountPaid))}</strong></div>
${cashReceived}
<div class="row"><span>${change > 0 ? "Change" : "Balance"}</span><strong>${escapeHtml(receiptMoney(change))}</strong></div>
</section>
<footer class="thanks">Thank you for shopping with us!</footer>
</main></body></html>`;
}

export async function print80mmReceipt(receipt: SaleReceipt, printerName: string): Promise<void> {
  const qz = await getConnectedQz();
  const printers = await qz.printers.find();
  const printer = printerName.trim();
  if (!printer || !printers.includes(printer)) {
    throw new Error("The selected receipt printer is unavailable. Check its connection or select another printer in Receipt Printer Settings.");
  }
  const config = qz.configs.create(printer, {
    margins: 0,
    orientation: "portrait",
    scaleContent: false,
    colorType: "blackwhite",
    units: "mm",
  });
  await qz.print(config, [{
    type: "pixel",
    format: "html",
    flavor: "plain",
    data: build80mmReceiptHtml(receipt),
    options: { pageWidth: 80 / 25.4 },
  }]);
}
