#!/usr/bin/env python3
"""
Интеграционный тест-сьют для проверки работы Web-дашборда FastAPI (v2.0).
Проверяет эндпоинты статистики, получения заказов, симуляции авто-оплаты в Base
и общения с клиентом в чате FunPay через AI.
"""

import asyncio
import os
import unittest
from httpx import AsyncClient
from httpx import ASGITransport

from src.models.repository import OrderRepository
from src.services.automation_manager import AutomationManager
from src.web.app import WebDashboardApp


class TestWebDashboardAPI(unittest.IsolatedAsyncioTestCase):
    """Тестирование REST API Web-дашборда и симулятора v2.0."""

    async def asyncSetUp(self):
        self.test_db_path = "data/test_web_api.db"
        if os.path.exists(self.test_db_path):
            os.remove(self.test_db_path)

        self.repo = OrderRepository(self.test_db_path)
        self.manager = AutomationManager(repository=self.repo, use_mock_browser=True)
        self.web_app = WebDashboardApp(self.manager)
        self.client = AsyncClient(transport=ASGITransport(app=self.web_app.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        if os.path.exists(self.test_db_path):
            os.remove(self.test_db_path)

    async def test_01_get_stats(self):
        """Проверка эндпоинта /api/stats (финансовая статистика Base)."""
        response = await self.client.get("/api/stats")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("total_orders", data)
        self.assertIn("completed_orders", data)
        self.assertIn("onchain_tx_count", data)
        self.assertIn("total_usd_volume", data)
        self.assertIn("total_profit_usd", data)

    async def test_02_create_test_order(self):
        """Проверка эндпоинта /api/test_order (создание сделки с авто-оплатой)."""
        payload = {
            "login": "web_tester@gmail.com",
            "password": "WebPassword123",
            "require_2fa": False
        }
        response = await self.client.post("/api/test_order", json=payload)
        self.assertEqual(response.status_code, 200)
        res_data = response.json()
        self.assertEqual(res_data["status"], "success")
        order_id = res_data["order_id"]
        self.assertTrue(order_id.startswith("#FP_"))

        # Даем время на выполнение авто-транзакции в Base
        await asyncio.sleep(4)

        # Проверяем в БД, что заказ завершен и появилась ончейн транзакция
        order = self.repo.get_order(order_id)
        self.assertIsNotNone(order)
        self.assertEqual(order.status.value, "completed")
        self.assertTrue(order.tx_hash.startswith("0x"), "Должен быть сгенерирован EVM хэш транзакции 0x...")

    async def test_03_chat_with_ai(self):
        """Проверка эндпоинта /api/chat_message (вопрос от покупателя к AI-ассистенту)."""
        # Сначала создаем заказ
        order = await self.manager.simulate_test_order("ai_user@gmail.com", "pwd", require_2fa=False)
        order_id = order.order_id

        # Отправляем сообщение-вопрос в чат от лица покупателя
        chat_payload = {
            "order_id": order_id,
            "text": "А сколько длится подписка?"
        }
        response = await self.client.post("/api/chat_message", json=chat_payload)
        self.assertEqual(response.status_code, 200)
        res_data = response.json()
        self.assertEqual(res_data["status"], "success")
        reply = res_data["reply"]
        self.assertTrue(len(reply) > 10, "AI должен вернуть содержательный ответ")
        self.assertIn("месяц", reply.lower())

        # Проверяем, что оба сообщения (вопрос и ответ) сохранились в истории заказа
        updated = self.repo.get_order(order_id)
        self.assertGreaterEqual(len(updated.chat_history), 2)
        self.assertEqual(updated.chat_history[-2].role, "buyer")
        self.assertEqual(updated.chat_history[-1].role, "ai")


if __name__ == "__main__":
    print("=========================================================================")
    print("🚀 ЗАПУСК НАБОРА ТЕСТОВ WEB-ДАШБОРДА (FastAPI v2.0)")
    print("=========================================================================")
    unittest.main(verbosity=2)
