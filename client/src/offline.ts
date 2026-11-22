export type OfflineSalePayment = {
  method: "cash";
  amount: string;
  providerReference?: string;
};

export type OfflineSaleRecord = {
  offlineId: string;
  items: Array<{ productId: number; quantity: string }>;
  discount: string;
  payments: OfflineSalePayment[];
  cashReceived: string | null;
  recordedAt: string;
  status: "pending" | "syncing" | "failed";
  attempts: number;
  error?: string;
};

const databaseName = "smart-pos-offline";
const storeName = "offline-sales";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        const store = database.createObjectStore(storeName, { keyPath: "offlineId" });
        store.createIndex("status", "status", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage could not be opened."));
  });
}

export async function saveOfflineSale(record: OfflineSaleRecord): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline sale could not be stored."));
  });
  database.close();
}

export async function listOfflineSales(): Promise<OfflineSaleRecord[]> {
  const database = await openDatabase();
  const records = await new Promise<OfflineSaleRecord[]>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as OfflineSaleRecord[]);
    request.onerror = () => reject(request.error ?? new Error("Offline sales could not be read."));
  });
  database.close();
  return records.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

export async function updateOfflineSale(record: OfflineSaleRecord): Promise<void> {
  await saveOfflineSale(record);
}

export async function removeOfflineSale(offlineId: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(offlineId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Synced offline sale could not be cleared."));
  });
  database.close();
}
