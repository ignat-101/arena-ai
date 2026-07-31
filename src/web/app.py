"""
FastAPI Web-дашборд и интерактивный симулятор заказов / AI чата FunPay.
Позволяет управлять ботом не только через Telegram, но и через браузер.
"""

import asyncio
import os
from pathlib import Path
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import uvicorn

from src.config import config
from src.utils.logger import logger
from src.models.order import Order, OrderStatus
from src.models.repository import OrderRepository
from src.services.automation_manager import AutomationManager


class TestOrderRequest(BaseModel):
    """Модель запроса создания тестового заказа с Web UI."""
    login: str
    password: str
    require_2fa: bool = False


class ChatMessageRequest(BaseModel):
    """Модель отправки сообщения в чат FunPay с Web UI."""
    order_id: str
    text: str


class OrderActionRequest(BaseModel):
    """Модель действия с заказом (подтверждение / авто-оплата в Base)."""
    order_id: str


class WebDashboardApp:
    """Менеджер Web-приложения FastAPI и сервера Uvicorn."""

    def __init__(self, automation_manager: AutomationManager):
        self.manager = automation_manager
        self.repository = automation_manager.repository
        self.app = FastAPI(
            title="X Premium FunPay Automation v2.0",
            description="Web Дашборд • Base Crypto Auto-Pay • OpenRouter AI Ассистент",
            version="2.0.0"
        )
        self.templates = Jinja2Templates(directory=str(Path("src/web/templates")))
        self._setup_routes()

    def _setup_routes(self) -> None:
        """Регистрирует маршруты и API эндпоинты в FastAPI."""

        @self.app.get("/", response_class=HTMLResponse)
        async def render_dashboard(request: Request):
            """Отображает главный дашборд и симулятор чата."""
            return self.templates.TemplateResponse("index.html", {"request": request})

        @self.app.get("/api/stats")
        async def get_statistics():
            """Возвращает финансовую статистику и KPI по ончейн сделкам Base."""
            summary = self.repository.get_financial_summary()
            return JSONResponse(summary)

        @self.app.get("/api/orders")
        async def get_orders(limit: int = 25):
            """Возвращает список заказов из базы данных вместе с историей чата и tx_hash."""
            orders = self.repository.get_all_orders(limit=limit)
            result = []
            for o in orders:
                result.append({
                    "order_id": o.order_id,
                    "funpay_chat_id": o.funpay_chat_id,
                    "buyer_username": o.buyer_username,
                    "status": o.status.value,
                    "login": o.credentials.login,
                    "tx_hash": o.tx_hash or "",
                    "amount_crypto": o.amount_crypto,
                    "amount_usd": o.amount_usd,
                    "profit_usd": o.profit_usd,
                    "payment_method": o.payment_method,
                    "chat_history": [m.model_dump() for m in o.chat_history],
                    "error_message": o.error_message or "",
                    "created_at": o.created_at,
                    "updated_at": o.updated_at
                })
            return JSONResponse(result)

        @self.app.post("/api/test_order")
        async def create_test_order(payload: TestOrderRequest):
            """Создает тестовый заказ с возможностью проверки 2FA и авто-оплаты в Base."""
            logger.info(f"🌐 [Web UI] Запуск тестового заказа: {payload.login} (2FA={payload.require_2fa})")
            order = await self.manager.simulate_test_order(
                login=payload.login,
                password=payload.password,
                require_2fa=payload.require_2fa
            )
            return {"status": "success", "message": f"Заказ {order.order_id} запущен в обработку", "order_id": order.order_id}

        @self.app.post("/api/chat_message")
        async def post_chat_message(payload: ChatMessageRequest):
            """
            Симулирует отправку сообщения покупателем в чат FunPay.
            Если сообщение является вопросом, AI-ассистент OpenRouter автоматически сгенерирует ответ.
            Если это 2FA-код при ожидании 2FA — бот введет его на странице X.com!
            """
            order = self.repository.get_order(payload.order_id)
            if not order:
                raise HTTPException(status_code=404, detail="Заказ не найден")

            logger.info(f"💬 [Web UI Чат {order.order_id}] Покупатель пишет: '{payload.text}'")

            # Проверяем, не является ли сообщение 2FA кодом, если заказ ждет 2FA
            if order.status == OrderStatus.WAITING_2FA and len(payload.text.strip()) in (6, 7, 8) and payload.text.strip().isdigit():
                logger.info(f"🔑 [Web UI Чат {order.order_id}] Перехват ввода 2FA кода: '{payload.text}'")
                order.add_chat_message("buyer", payload.text)
                self.repository.save_order(order)
                await self.manager.handle_buyer_2fa_code(order.funpay_chat_id, payload.text.strip())
                return {"status": "success", "reply": "Код 2FA отправлен в браузер"}

            # Иначе обрабатываем сообщение через AI ассистента
            ai_reply = await self.manager.handle_buyer_chat_message(
                chat_id=order.funpay_chat_id,
                text=payload.text,
                buyer_username=order.buyer_username
            )
            return {"status": "success", "reply": ai_reply}

        @self.app.post("/api/confirm_payment")
        async def confirm_payment(payload: OrderActionRequest):
            """
            Подтверждает оплату или запускает автоматическую ончейн-транзакцию Base
            по кнопке из Web UI.
            """
            order = self.repository.get_order(payload.order_id)
            if not order:
                raise HTTPException(status_code=404, detail="Заказ не найден")

            logger.info(f"⚡ [Web UI] Подтверждение оплаты / Запуск ончейн-транзакции в Base для #{order.order_id}...")
            if order.status != OrderStatus.COMPLETED:
                await self.manager.trigger_manual_auto_payment(order.order_id)
            return {"status": "success", "message": f"Заказ {order.order_id} завершен"}

    def run_server(self, host: str = "0.0.0.0", port: int = 8000) -> None:
        """Запускает синхронный сервер Uvicorn."""
        logger.info(f"🌐 Запуск Web-дашборда и симулятора по адресу http://{host}:{port}/")
        uvicorn.run(self.app, host=host, port=port, log_level="warning")


# Проверочный пример
if __name__ == "__main__":
    from src.services.automation_manager import AutomationManager
    mgr = AutomationManager(use_mock_browser=True)
    web_app = WebDashboardApp(mgr)
    print("FastAPI WebDashboardApp инициализирован успешно!")
