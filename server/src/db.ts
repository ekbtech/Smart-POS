import "./env.js";
import mysql, { type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";

type SqlValue = string | number | bigint | boolean | Date | null;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be configured.");

export const pool = mysql.createPool(databaseUrl);

export async function query<T extends RowDataPacket[]>(sql: string, values: SqlValue[] = []): Promise<T> {
  const [rows] = await pool.execute<T>(sql, values);
  return rows;
}

export async function execute(sql: string, values: SqlValue[] = []): Promise<ResultSetHeader> {
  const [result] = await pool.execute<ResultSetHeader>(sql, values);
  return result;
}

export async function withTransaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
