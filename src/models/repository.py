"""
Модуль для работы с локальной базой данных SQLite v2.0.
Сохранение заказов, учет ончейн-транзакций Base, финансовая статистика и миграции.
"""

import sqlite3
import json
from typing import List, Optional, Dict, Any
from pathlib import Path

from src.models.order import Order, OrderStatus
from src.utils.logger import logger
from src.config import config


class OrderRepository:
    """Репозиторий для сохранения, обновления и финансового учета заказов в SQLite."""

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or config.DATABASE_PATH
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._run_migrations()

    def _get_connection(self) -> sqlite3.Connection:
        """Создает подключение к SQLite базе данных."""
        conn = sqlite3.Connection(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        """Создает таблицу заказов с учетом финансовых и ончейн полей."""
        query = """
        CREATE TABLE IF NOT EXISTS orders (
            order_id TEXT PRIMARY KEY,
            funpay_chat_id INTEGER NOT NULL,
            buyer_username TEXT NOT NULL,
            status TEXT NOT NULL,
            login TEXT NOT NULL,
            password TEXT NOT NULL,
            extra_username TEXT DEFAULT '',
            two_factor_type TEXT DEFAULT '',
            two_factor_hint TEXT DEFAULT '',
            two_factor_code TEXT DEFAULT '',
            qr_uri TEXT DEFAULT '',
            tx_hash TEXT DEFAULT '',
            amount_crypto TEXT DEFAULT '0.0035 ETH',
            amount_usd REAL DEFAULT 8.00,
            profit_usd REAL DEFAULT 3.50,
            payment_method TEXT DEFAULT 'base_automatic',
            chat_history_json TEXT DEFAULT '[]',
            error_message TEXT DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        """
        with self._get_connection() as conn:
            conn.execute(query)
            conn.commit()
        logger.debug(f"База данных SQLite инициализирована: {self.db_path}")

    def _run_migrations(self) -> None:
        """Автоматическая миграция схемы для добавления новых столбцов, если БД уже существовала."""
        expected_columns = {
            "tx_hash": "TEXT DEFAULT ''",
            "amount_crypto": "TEXT DEFAULT '0.0035 ETH'",
            "amount_usd": "REAL DEFAULT 8.00",
            "profit_usd": "REAL DEFAULT 3.50",
            "payment_method": "TEXT DEFAULT 'base_automatic'",
            "chat_history_json": "TEXT DEFAULT '[]'",
        }
        with self._get_connection() as conn:
            cursor = conn.execute("PRAGMA table_info(orders);")
            existing_cols = {row["name"] for row in cursor.fetchall()}
            for col_name, col_def in expected_columns.items():
                if col_name not in existing_cols:
                    try:
                        conn.execute(f"ALTER TABLE orders ADD COLUMN {col_name} {col_def};")
                        conn.commit()
                        logger.info(f"Выполнена миграция БД: добавлен столбец {col_name}")
                    except Exception as e:
                        logger.warning(f"Ошибка миграции {col_name}: {e}")

    def save_order(self, order: Order) -> None:
        """Сохраняет или обновляет заказ в базе данных."""
        query = """
        INSERT OR REPLACE INTO orders (
            order_id, funpay_chat_id, buyer_username, status,
            login, password, extra_username,
            two_factor_type, two_factor_hint, two_factor_code,
            qr_uri, tx_hash, amount_crypto, amount_usd, profit_usd, payment_method, chat_history_json,
            error_message, created_at, updated_at
        ) VALUES (
            :order_id, :funpay_chat_id, :buyer_username, :status,
            :login, :password, :extra_username,
            :two_factor_type, :two_factor_hint, :two_factor_code,
            :qr_uri, :tx_hash, :amount_crypto, :amount_usd, :profit_usd, :payment_method, :chat_history_json,
            :error_message, :created_at, :updated_at
        );
        """
        try:
            with self._get_connection() as conn:
                conn.execute(query, order.to_db_dict())
                conn.commit()
            logger.debug(f"Заказ #{order.order_id} успешно сохранен (статус: {order.status.value})")
        except Exception as e:
            logger.error(f"Ошибка при сохранении заказа #{order.order_id}: {e}")

    def get_order(self, order_id: str) -> Optional[Order]:
        """Возвращает заказ по его ID или None, если он не найден."""
        query = "SELECT * FROM orders WHERE order_id = ?;"
        with self._get_connection() as conn:
            cursor = conn.execute(query, (order_id,))
            row = cursor.fetchone()
            if row:
                return Order.from_db_dict(dict(row))
        return None

    def get_order_by_chat_id(self, funpay_chat_id: int) -> Optional[Order]:
        """Возвращает последний активный заказ по ID чата FunPay."""
        query = "SELECT * FROM orders WHERE funpay_chat_id = ? ORDER BY updated_at DESC LIMIT 1;"
        with self._get_connection() as conn:
            cursor = conn.execute(query, (funpay_chat_id,))
            row = cursor.fetchone()
            if row:
                return Order.from_db_dict(dict(row))
        return None

    def get_active_orders(self) -> List[Order]:
        """Возвращает список всех незавершенных (активных) заказов."""
        query = """
        SELECT * FROM orders 
        WHERE status NOT IN ('completed', 'cancelled') 
        ORDER BY created_at ASC;
        """
        orders = []
        with self._get_connection() as conn:
            cursor = conn.execute(query)
            for row in cursor.fetchall():
                orders.append(Order.from_db_dict(dict(row)))
        return orders

    def get_all_orders(self, limit: int = 50) -> List[Order]:
        """Возвращает список всех заказов с сортировкой по новизне."""
        query = "SELECT * FROM orders ORDER BY created_at DESC LIMIT ?;"
        orders = []
        with self._get_connection() as conn:
            cursor = conn.execute(query, (limit,))
            for row in cursor.fetchall():
                orders.append(Order.from_db_dict(dict(row)))
        return orders

    def get_financial_summary(self) -> Dict[str, Any]:
        """Возвращает агрегированную статистику по сделкам, выручке и прибыли в сети Base."""
        query = """
        SELECT 
            COUNT(*) as total_orders,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
            SUM(CASE WHEN status = 'completed' THEN amount_usd ELSE 0 END) as total_usd_volume,
            SUM(CASE WHEN status = 'completed' THEN profit_usd ELSE 0 END) as total_profit_usd,
            SUM(CASE WHEN tx_hash != '' THEN 1 ELSE 0 END) as onchain_tx_count
        FROM orders;
        """
        with self._get_connection() as conn:
            cursor = conn.execute(query)
            row = dict(cursor.fetchone() or {})
            return {
                "total_orders": int(row.get("total_orders", 0) or 0),
                "completed_orders": int(row.get("completed_orders", 0) or 0),
                "total_usd_volume": round(float(row.get("total_usd_volume", 0.0) or 0.0), 2),
                "total_profit_usd": round(float(row.get("total_profit_usd", 0.0) or 0.0), 2),
                "onchain_tx_count": int(row.get("onchain_tx_count", 0) or 0),
            }


# Проверочный пример для локального тестирования
if __name__ == "__main__":
    repo = OrderRepository("data/test_orders_v2.db")
    from src.models.order import BuyerCredentials
    test_order = Order(
        order_id="#999888777",
        funpay_chat_id=123456,
        buyer_username="crypto_buyer",
        credentials=BuyerCredentials(login="test_user@gmail.com", password="SecretPassword123"),
        tx_hash="0x8f4b1e9c7a2d6b3e0a112233445566778899aabbccddeeff0011223344556677"
    )
    test_order.add_chat_message("buyer", "Привет! Сколько длится подписка?")
    test_order.add_chat_message("ai", "Здравствуйте! Подписка активируется на 1 месяц.")
    repo.save_order(test_order)
    retrieved = repo.get_order("#999888777")
    print(f"Заказ v2 успешно сохранен: ID={retrieved.order_id}, tx={retrieved.tx_hash[:10]}..., сообщений={len(retrieved.chat_history)}")
    print("Статистика:", repo.get_financial_summary())
